import type {
  Device,
  Ipv4Address,
  PortId,
  SwitchConfig,
  VirtualInterfaceId,
  VlanId,
  VtpMode,
} from '@/model';
import { carriesVlan } from '@/model/vlans';
import {
  VTP_SUMMARY_INTERVAL,
  vtpDigest,
  vtpMode,
  vtpRevision,
  vtpVersion,
  type VlanDatabase,
} from '@/model/vtp';
import { ms, type SimTime } from '../core/time';
import type { Frame } from '../frame';
import type { DeviceContext, ModuleContext, SimModule } from '../module';
import { CDP_MAC, type EthernetFrame, type VtpPdu } from '../pdu';
import type { VtpStatus } from './status';

/**
 * VTP versions 1 and 2. A server or client in a domain advertises its VLAN database out of its up
 * trunks: a summary every five minutes and when a trunk comes up, and a summary with the VLANs
 * after each change on a server. A server or client that hears a higher revision in its domain,
 * with a digest its own password agrees with, takes those VLANs and sends them on. A switch in no
 * domain joins the first one it hears. A transparent switch keeps its own VLANs and passes VTP
 * through. The VLANs a switch takes go into its config through `storeVlans`; the module keeps
 * them too, so it sends them on before the config catches up.
 */

type Switch = Extract<Device, { kind: 'switch' }>;
type Summary = Extract<VtpPdu, { code: 'summary' }>;

export type VtpState = {
  /**
   * The VLAN database the switch holds: its config's, or a newer one it took that the config has
   * not caught up with. A domain of '' is none.
   */
  database: VlanDatabase;
  /** The config's mode and password when the module last looked, to spot a change. */
  mode: VtpMode;
  password: string | undefined;
  /** Who made the change the database is at, and when, as `yymmddhhmmss`. */
  updater: Ipv4Address;
  timestamp: string;
  /** The trunks that were up when the module last looked, to spot one coming up. */
  trunks: Set<PortId>;
  /** A summary of a newer revision, waiting for the subset that carries its VLANs. */
  awaiting: { readonly port: PortId; readonly summary: Summary } | undefined;
};

type Ctx = ModuleContext<VtpState>;

const NO_ADDRESS = '0.0.0.0' as Ipv4Address;
const NEVER = '000000000000';
const SYNC = 'sync';
const SUMMARY = 'summary';
const SUMMARY_PERIOD = ms(VTP_SUMMARY_INTERVAL * 1000);
const VLAN1 = 1 as VlanId;

/** Packet Tracer's clock starts at 1 March 1993, midnight, when the simulation does. */
const CLOCK_START = Date.UTC(1993, 2, 1);

/** The simulated time as VTP stamps a change: `yymmddhhmmss`. */
export function vtpTimestamp(now: SimTime): string {
  const at = new Date(CLOCK_START + now);
  return [
    at.getUTCFullYear() % 100,
    at.getUTCMonth() + 1,
    at.getUTCDate(),
    at.getUTCHours(),
    at.getUTCMinutes(),
    at.getUTCSeconds(),
  ]
    .map((part) => String(part).padStart(2, '0'))
    .join('');
}

const switchOf = (ctx: DeviceContext): Switch | undefined =>
  ctx.device.kind === 'switch' ? ctx.device : undefined;

/** The database the config holds. A transparent switch's revision is always 0. */
function configDatabase(config: SwitchConfig): VlanDatabase {
  return {
    domain: config.vtp?.domain ?? '',
    revision: vtpMode(config) === 'transparent' ? 0 : vtpRevision(config),
    version: vtpVersion(config),
    vlans: config.vlans,
  };
}

const vlanKey = (vlans: VlanDatabase['vlans']) =>
  Object.entries(vlans)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([id, vlan]) => `${id}=${vlan.name}`)
    .join('\n');

const sameDatabase = (a: VlanDatabase, b: VlanDatabase) =>
  a.domain === b.domain &&
  a.revision === b.revision &&
  a.version === b.version &&
  vlanKey(a.vlans) === vlanKey(b.vlans);

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

/** The digest of `database` under `password`, as a summary carries it. */
const digestOf = (database: VlanDatabase, password: string | undefined) =>
  hex(
    vtpDigest({
      vtp: {
        domain: database.domain,
        revision: database.revision,
        ...(password !== undefined && { password }),
      },
      vlans: database.vlans,
    }),
  );

function summary(state: VtpState, followers: number): Summary {
  const { database } = state;
  return {
    kind: 'vtp',
    code: 'summary',
    version: database.version,
    domain: database.domain,
    revision: database.revision,
    followers,
    updater: state.updater,
    timestamp: state.timestamp,
    digest: digestOf(database, state.password),
  };
}

function subset({ database }: VtpState): VtpPdu {
  return {
    kind: 'vtp',
    code: 'subset',
    version: database.version,
    domain: database.domain,
    revision: database.revision,
    sequence: 1,
    vlans: Object.entries(database.vlans)
      .map(([id, vlan]) => ({ id: Number(id) as VlanId, name: vlan.name }))
      .sort((a, b) => a.id - b.id),
  };
}

const request = ({ database }: VtpState): VtpPdu => ({
  kind: 'vtp',
  code: 'request',
  version: database.version,
  domain: database.domain,
  start: 1,
});

/** A summary and the subset with the VLANs, as a switch sends after a change or on request. */
const advertisement = (state: VtpState) => [summary(state, 1), subset(state)];

/** A trunk's switchport mode, read from the port's own config. */
const isTrunk = (device: Switch, port: PortId) =>
  device.config.interfaces[port]?.switchport?.mode === 'trunk';

const upTrunks = (ctx: DeviceContext, device: Switch) =>
  device.ports
    .filter((port) => isTrunk(device, port.id) && ctx.portUp(port.id))
    .map((port) => port.id);

function sendOn(ctx: DeviceContext, port: PortId, payloads: readonly VtpPdu[]) {
  const hardware = ctx.device.ports.find((candidate) => candidate.id === port);
  if (!hardware || hardware.kind === 'serial') return;
  for (const payload of payloads) {
    ctx.send(port, { kind: 'ethernet', dst: CDP_MAC, src: hardware.mac, payload });
  }
}

/**
 * The up trunks other than `except` that `keep` lets through, one member per EtherChannel and
 * none of the bundle `except` belongs to.
 */
function floodPorts(
  ctx: DeviceContext,
  device: Switch,
  except?: PortId,
  keep: (port: PortId) => boolean = () => true,
) {
  const skip = except === undefined ? undefined : ctx.bundleOf(except);
  const bundles = new Set<string>();
  return upTrunks(ctx, device).filter((port) => {
    if (port === except || !keep(port)) return false;
    const bundle = ctx.bundleOf(port);
    if (bundle === undefined) return true;
    if (bundle === skip || bundles.has(bundle)) return false;
    bundles.add(bundle);
    return true;
  });
}

const flood = (ctx: Ctx, device: Switch, payloads: readonly VtpPdu[], except?: PortId) => {
  for (const port of floodPorts(ctx, device, except)) sendOn(ctx, port, payloads);
};

/** Whether the switch advertises: a server or client in a domain. */
const advertises = (state: VtpState) => state.mode !== 'transparent' && state.database.domain !== '';

/**
 * The address a server stamps its changes with: its lowest-numbered VLAN interface's that has an
 * address and is up, or none.
 */
export function localUpdater(
  ctx: DeviceContext,
  device: Switch,
): { readonly interface: VirtualInterfaceId; readonly address: Ipv4Address } | undefined {
  const candidates = Object.entries(device.config.virtualInterfaces)
    .filter(([id]) => id.startsWith('Vlan'))
    .map(([id, config]) => ({ id: id as VirtualInterfaceId, vlan: Number(id.slice(4)), config }))
    .sort((a, b) => a.vlan - b.vlan);
  for (const { id, vlan, config } of candidates) {
    if (!config.ipv4 || config.shutdown || !(vlan in device.config.vlans)) continue;
    const up = device.ports.some((port) => {
      const switchport = device.config.interfaces[port.id]?.switchport;
      return switchport && carriesVlan(switchport, vlan as VlanId) && ctx.portUp(port.id);
    });
    if (up) return { interface: id, address: config.ipv4.address };
  }
  return undefined;
}

/** Announces the switch on each trunk that came up since the module last looked. */
function syncTrunks(ctx: Ctx, device: Switch) {
  const { state } = ctx;
  const up = new Set(upTrunks(ctx, device));
  for (const port of up) {
    if (state.trunks.has(port) || !advertises(state)) continue;
    sendOn(ctx, port, [summary(state, 0)]);
    if (state.mode === 'client') sendOn(ctx, port, [request(state)]);
  }
  state.trunks = up;
  if (state.awaiting && !up.has(state.awaiting.port)) state.awaiting = undefined;
}

/** Takes the config's VTP settings and VLANs, and advertises a server's change to the domain. */
function onConfig(ctx: Ctx, device: Switch) {
  const { state } = ctx;
  const config = configDatabase(device.config);
  const mode = vtpMode(device.config);
  const password = device.config.vtp?.password;
  const before = state.database;
  const modeChanged = mode !== state.mode;
  const passwordChanged = password !== state.password;
  state.mode = mode;
  state.password = password;
  if (mode === 'transparent') {
    state.database = config;
    state.awaiting = undefined;
    return syncTrunks(ctx, device);
  }
  // The config catching up with an older update the module took since: nothing changed here.
  const stale = config.domain === before.domain && config.revision < before.revision;
  const changed = !stale && !sameDatabase(config, before);
  if (changed) state.database = config;
  const edited = config.revision > before.revision || vlanKey(config.vlans) !== vlanKey(before.vlans);
  if (changed && mode === 'server' && edited) {
    state.updater = localUpdater(ctx, device)?.address ?? NO_ADDRESS;
    state.timestamp = vtpTimestamp(ctx.now);
  }
  if (advertises(state) && mode === 'server' && (changed || passwordChanged || modeChanged)) {
    flood(ctx, device, advertisement(state));
  }
  if (advertises(state) && mode === 'client' && modeChanged) flood(ctx, device, [request(state)]);
  syncTrunks(ctx, device);
}

function hearSummary(ctx: Ctx, port: PortId, pdu: Summary) {
  const { state } = ctx;
  if (pdu.revision <= state.database.revision) return;
  state.awaiting = { port, summary: pdu };
  if (pdu.followers === 0) sendOn(ctx, port, [request(state)]);
}

/** Takes the subset's VLANs if they belong to the summary before it and its digest agrees. */
function hearSubset(ctx: Ctx, device: Switch, port: PortId, pdu: Extract<VtpPdu, { code: 'subset' }>) {
  const { state } = ctx;
  const waiting = state.awaiting;
  if (!waiting || waiting.port !== port || waiting.summary.revision !== pdu.revision) return;
  state.awaiting = undefined;
  if (pdu.revision <= state.database.revision) return;
  const database: VlanDatabase = {
    domain: pdu.domain,
    revision: pdu.revision,
    version: waiting.summary.version,
    vlans: Object.fromEntries(
      pdu.vlans.map((vlan) => [vlan.id, { name: vlan.name }]),
    ) as VlanDatabase['vlans'],
  };
  if (digestOf(database, state.password) !== waiting.summary.digest) return;
  state.database = database;
  state.updater = waiting.summary.updater;
  state.timestamp = waiting.summary.timestamp;
  ctx.storeVlans(database);
  flood(ctx, device, advertisement(state), port);
}

/**
 * A transparent switch passes VTP on unread, out of its other trunks that forward VLAN 1, so a
 * loop of them cannot storm. Version 1 passes only its own domain's, or every one in no domain.
 */
function relay(ctx: Ctx, device: Switch, port: PortId, frame: EthernetFrame, pdu: VtpPdu) {
  const domain = device.config.vtp?.domain;
  if (vtpVersion(device.config) === 1 && domain !== undefined && pdu.domain !== domain) return;
  if (!ctx.forwards(port, VLAN1)) return;
  for (const out of floodPorts(ctx, device, port, (candidate) => ctx.forwards(candidate, VLAN1))) {
    ctx.send(out, frame);
  }
}

function hear(ctx: Ctx, device: Switch, port: PortId, frame: EthernetFrame, pdu: VtpPdu) {
  const { state } = ctx;
  if (state.mode === 'transparent') return relay(ctx, device, port, frame, pdu);
  if (state.database.domain === '') {
    if (pdu.code !== 'summary' || pdu.domain === '') return;
    state.database = { ...state.database, domain: pdu.domain };
    ctx.storeVlans(state.database);
  }
  if (pdu.domain !== state.database.domain) return;
  switch (pdu.code) {
    case 'summary':
      return hearSummary(ctx, port, pdu);
    case 'subset':
      return hearSubset(ctx, device, port, pdu);
    case 'request':
      return sendOn(ctx, port, advertisement(state));
  }
}

const vtpFrame = (frame: Frame): (EthernetFrame & { payload: VtpPdu }) | undefined =>
  frame.kind === 'ethernet' && frame.dst === CDP_MAC && frame.payload.kind === 'vtp'
    ? (frame as EthernetFrame & { payload: VtpPdu })
    : undefined;

export const vtpModule: SimModule<VtpState> = {
  id: 'vtp',
  init(ctx) {
    // Links come up before the module starts, so the first summaries wait for its timer.
    ctx.setTimer(SYNC, ms(0));
    ctx.setTimer(SUMMARY, SUMMARY_PERIOD);
    const config = switchOf(ctx)?.config;
    return {
      database: config
        ? configDatabase(config)
        : { domain: '', revision: 0, version: 1, vlans: {} },
      mode: config ? vtpMode(config) : 'server',
      password: config?.vtp?.password,
      updater: NO_ADDRESS,
      timestamp: NEVER,
      trunks: new Set(),
      awaiting: undefined,
    };
  },
  onFrame(ctx, port, frame) {
    const device = switchOf(ctx);
    const vtp = vtpFrame(frame);
    if (!device || !vtp || !isTrunk(device, port) || !ctx.portUp(port)) return;
    hear(ctx, device, port, vtp, vtp.payload);
  },
  onTimer(ctx, key) {
    const device = switchOf(ctx);
    if (!device) return;
    if (key === SYNC) return syncTrunks(ctx, device);
    if (key !== SUMMARY) return;
    ctx.setTimer(SUMMARY, SUMMARY_PERIOD);
    if (advertises(ctx.state)) flood(ctx, device, [summary(ctx.state, 0)]);
  },
  onLinkChange(ctx) {
    const device = switchOf(ctx);
    if (device) syncTrunks(ctx, device);
  },
  onConfigChange(ctx) {
    const device = switchOf(ctx);
    if (device) onConfig(ctx, device);
  },
};

/** Who last changed the VLANs and when, and the address a change made here would carry. */
export function vtpStatus(ctx: Ctx): VtpStatus | undefined {
  const device = switchOf(ctx);
  if (!device) return undefined;
  const updater = localUpdater(ctx, device);
  return {
    lastModifiedBy: ctx.state.updater,
    lastModifiedAt: ctx.state.timestamp,
    ...(updater && { localUpdater: updater }),
  };
}
