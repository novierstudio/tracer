import type {
  Device,
  LoadBalance,
  MacAddress,
  Port,
  PortId,
  SwitchedInterface,
  SwitchInterface,
  Switchport,
} from '@/model';
import {
  channelProtocol,
  DEFAULT_LOAD_BALANCE,
  portChannelId,
  type ChannelProtocol,
} from '@/model/l2';
import { ms, type SimTime } from '../core/time';
import type { DeviceContext } from '../module';
import {
  SLOW_PROTOCOLS_MAC,
  CDP_MAC,
  type EthernetFrame,
  type LacpPdu,
  type PagpPdu,
} from '../pdu';
import type { ChannelMember, ChannelPortFlag, EtherChannelStatus } from './status';

/**
 * EtherChannel: ports in one channel group bundle into a port-channel, which spanning tree and
 * the MAC table treat as one port. Mode `on` bundles unconditionally; LACP (active, passive) and
 * PAgP (desirable, auto) bundle a port once it hears a partner speaking the same protocol, and
 * at least one end of the link starts the conversation. The switching module owns this state.
 */

type Switch = Extract<Device, { kind: 'switch' }>;

/** What a member port last heard from the far end of its link. */
type Partner = {
  readonly protocol: ChannelProtocol;
  readonly system: MacAddress;
  readonly port: number;
  readonly key: number;
  /** The partner starts conversations: LACP active or PAgP desirable. */
  readonly initiates: boolean;
};

export type ChannelState = {
  readonly partners: Map<PortId, Partner>;
  /** Ports that start conversations and are up, so send a PDU every period. */
  readonly speaking: Set<PortId>;
  /** Each member's state as last worked out, by port. */
  readonly flags: Map<PortId, ChannelPortFlag>;
  readonly bundledAt: Map<PortId, SimTime>;
  /** When each group's port-channel came up, while it is. */
  readonly upSince: Map<number, SimTime>;
};

export const createChannelState = (): ChannelState => ({
  partners: new Map(),
  speaking: new Set(),
  flags: new Map(),
  bundledAt: new Map(),
  upSince: new Map(),
});

/** LACP's slow rate and PAgP's steady rate: a PDU every 30 s, a partner lost after 3 missed. */
const PERIOD = ms(30_000);
const PARTNER_TIMEOUT = ms(90_000);

const TIMER_PREFIX = 'ec';

/** A port-channel stands in for its members as one port of the bridge, under its own name. */
export const portChannelPort = (group: number) => portChannelId(group) as string as PortId;

export const isPortChannel = (port: PortId) => port.startsWith('Port-channel');

const groupOfPort = (port: PortId) => Number(port.slice('Port-channel'.length));

/** The ports configured into channel groups, in hardware order, by group. */
export function channelGroups(device: Switch): Map<number, PortId[]> {
  const groups = new Map<number, PortId[]>();
  for (const port of device.ports) {
    const group = device.config.interfaces[port.id]?.channelGroup?.group;
    if (group !== undefined) groups.set(group, [...(groups.get(group) ?? []), port.id]);
  }
  return new Map([...groups].sort(([a], [b]) => a - b));
}

const ethernet = (device: Switch, port: PortId) => {
  const hardware = device.ports.find((candidate) => candidate.id === port);
  return hardware && hardware.kind !== 'serial' ? hardware : undefined;
};

/** The switch's system address in LACP and PAgP: its first Ethernet MAC, as its bridge ID's. */
function systemMac(device: Switch): MacAddress | undefined {
  for (const port of device.ports) if (port.kind !== 'serial') return port.mac;
  return undefined;
}

const portNumber = (device: Switch, port: PortId) =>
  device.ports.findIndex((candidate) => candidate.id === port) + 1;

/** The port-channel's switchport, else its first member's. */
export function bundleSwitchport(device: Switch, group: number): Switchport | undefined {
  const po = device.config.portChannels?.[portChannelId(group)];
  if (po) return po.switchport;
  const first = channelGroups(device).get(group)?.[0];
  return first && device.config.interfaces[first]?.switchport;
}

const sameVlans = (a: Switchport, b: Switchport) =>
  a.mode === b.mode &&
  (a.mode === 'access' ? a.vlan : a.nativeVlan) === (b.mode === 'access' ? b.vlan : b.nativeVlan) &&
  JSON.stringify(a.allowedVlans ?? null) === JSON.stringify(b.allowedVlans ?? null);

/**
 * Whether a member's settings let it join its bundle: the port-channel's VLAN settings, and the
 * kind, speed and duplex of the group's first member. IOS suspends a port that differs.
 */
function compatible(device: Switch, group: number, port: PortId): boolean {
  const config = device.config.interfaces[port];
  const reference = bundleSwitchport(device, group);
  if (!config?.switchport || !reference || !sameVlans(config.switchport, reference)) return false;
  const first = channelGroups(device).get(group)?.[0];
  if (!first || first === port) return true;
  const lead = device.config.interfaces[first];
  return (
    ethernet(device, first)?.kind === ethernet(device, port)?.kind &&
    lead?.speed === config.speed &&
    lead?.duplex === config.duplex
  );
}

/** Each member's state now, from the config, the links and what the partners said. */
function workOutFlags(ctx: DeviceContext, device: Switch, state: ChannelState) {
  const flags = new Map<PortId, ChannelPortFlag>();
  for (const [group, ports] of channelGroups(device)) {
    let aggregator: MacAddress | undefined;
    for (const port of ports) {
      const mode = device.config.interfaces[port]!.channelGroup!.mode;
      const protocol = channelProtocol(mode);
      if (!ctx.portUp(port)) {
        flags.set(port, 'D');
        continue;
      }
      if (!compatible(device, group, port)) {
        flags.set(port, 's');
        continue;
      }
      if (!protocol) {
        flags.set(port, 'P');
        continue;
      }
      const partner = state.partners.get(port);
      const starts = mode === 'active' || mode === 'desirable';
      if (!partner || partner.protocol !== protocol || !(starts || partner.initiates)) {
        flags.set(port, 'I');
        continue;
      }
      // Every member must reach the same partner system as the first one that bundles.
      aggregator ??= partner.system;
      flags.set(port, partner.system === aggregator ? 'P' : 's');
    }
  }
  return flags;
}

/** The members bundled in a group now, in hardware order. */
export function bundled(state: ChannelState, device: Switch, group: number): PortId[] {
  return (channelGroups(device).get(group) ?? []).filter((port) => state.flags.get(port) === 'P');
}

/**
 * The port the bridge sees a physical port as: its port-channel while bundled, else itself. A
 * member that is suspended, down or waiting is undefined: the bridge neither learns from it nor
 * forwards out of it.
 */
export function logicalPort(device: Switch, state: ChannelState, port: PortId): PortId | undefined {
  const group = device.config.interfaces[port]?.channelGroup?.group;
  if (group === undefined) return port;
  const flag = state.flags.get(port);
  if (flag === 'P') return portChannelPort(group);
  return flag === 'I' ? port : undefined;
}

/** The ports of the bridge: unbundled ports, then a port-channel for each group in use. */
export function logicalPorts(device: Switch, state: ChannelState): PortId[] {
  const ports = device.ports
    .map((port) => logicalPort(device, state, port.id))
    .filter((port): port is PortId => port !== undefined);
  return [...new Set(ports)];
}

/** The bundled member a frame leaves by, chosen from its addresses by `port-channel load-balance`. */
export function memberFor(
  device: Switch,
  state: ChannelState,
  group: number,
  frame: EthernetFrame,
): PortId | undefined {
  const members = bundled(state, device, group);
  if (members.length === 0) return undefined;
  const hash = loadBalanceHash(device.config.loadBalance ?? DEFAULT_LOAD_BALANCE, frame);
  return members[hash % members.length];
}

const lowByte = (mac: MacAddress) => parseInt(mac.slice(-2), 16);
const lowOctet = (address: string) => Number(address.split('.').at(-1));

/** The low bits of the chosen addresses, XORed when both count, as Catalyst switches hash. */
export function loadBalanceHash(method: LoadBalance, frame: EthernetFrame): number {
  const { payload } = frame;
  const ip = payload.kind === 'ipv4' ? payload : undefined;
  const src = ip ? lowOctet(ip.src) : lowByte(frame.src);
  const dst = ip ? lowOctet(ip.dst) : lowByte(frame.dst);
  switch (method) {
    case 'src-mac':
      return lowByte(frame.src);
    case 'dst-mac':
      return lowByte(frame.dst);
    case 'src-dst-mac':
      return lowByte(frame.src) ^ lowByte(frame.dst);
    case 'src-ip':
      return src;
    case 'dst-ip':
      return dst;
    case 'src-dst-ip':
      return src ^ dst;
  }
}

/**
 * The switch as its bridge sees it: bundled members leave and each port-channel in use joins,
 * with its own switchport settings and the cost of the bundle's bandwidth. Port-channels number
 * after the hardware ports, so on a 26-port switch Po1 is port 27.
 */
export function bridgeView(device: Switch, state: ChannelState): Switch {
  const groups = channelGroups(device);
  if (groups.size === 0) return device;
  const last = Math.max(...groups.keys());
  const extra: Port[] = [];
  const interfaces: Record<string, SwitchInterface | undefined> = {
    ...device.config.interfaces,
  };
  for (let group = 1; group <= last; group++) {
    const id = portChannelPort(group);
    const members = bundled(state, device, group);
    const lead = members[0] && ethernet(device, members[0]);
    extra.push({ kind: lead?.kind ?? 'fastEthernet', id, mac: lead?.mac ?? ('' as MacAddress) });
    const switchport = bundleSwitchport(device, group);
    if (!lead || !switchport) continue;
    const po = device.config.portChannels?.[portChannelId(group)];
    const speed = device.config.interfaces[members[0]!]?.speed;
    const each = speed ?? (lead.kind === 'gigabitEthernet' ? 1000 : 100);
    interfaces[id] = {
      shutdown: false,
      switchport,
      stpCost: (po?.stpCost ?? bundleCost(each * members.length)) as SwitchedInterface['stpCost'],
      ...(po?.portfast && { portfast: true }),
    };
  }
  return {
    ...device,
    ports: [...device.ports, ...extra],
    config: { ...device.config, interfaces: interfaces as Switch['config']['interfaces'] },
  };
}

/** Spanning tree's short cost for a bundle's bandwidth in Mbit/s, as IOS assigns it. */
export function bundleCost(mbps: number): number {
  if (mbps >= 10_000) return 2;
  if (mbps >= 2000) return 3;
  if (mbps >= 1000) return 4;
  if (mbps >= 500) return 7;
  if (mbps >= 400) return 8;
  if (mbps >= 300) return 9;
  if (mbps >= 200) return 12;
  if (mbps >= 100) return 19;
  return 100;
}

/** Whether the bridge's view of a port is up: a port-channel while any member is bundled. */
export function bridgePortUp(
  ctx: DeviceContext,
  device: Switch,
  state: ChannelState,
  port: PortId,
): boolean {
  if (isPortChannel(port)) return bundled(state, device, groupOfPort(port)).length > 0;
  return ctx.portUp(port) && logicalPort(device, state, port) === port;
}

function sendPdu(ctx: DeviceContext, device: Switch, state: ChannelState, port: PortId) {
  const config = device.config.interfaces[port];
  const hardware = ethernet(device, port);
  const system = systemMac(device);
  const channel = config?.channelGroup;
  const protocol = channel && channelProtocol(channel.mode);
  if (!hardware || !system || !channel || !protocol || !ctx.portUp(port)) return;
  const heard = state.partners.get(port);
  const partner = heard?.protocol === protocol ? heard : undefined;
  const number = portNumber(device, port);
  if (protocol === 'lacp') {
    const pdu: LacpPdu = {
      kind: 'lacp',
      actor: { system, key: channel.group, port: number, active: channel.mode === 'active' },
      ...(partner && {
        partner: { system: partner.system, key: partner.key, port: partner.port },
      }),
    };
    ctx.send(port, { kind: 'ethernet', dst: SLOW_PROTOCOLS_MAC, src: hardware.mac, payload: pdu });
  } else {
    const pdu: PagpPdu = {
      kind: 'pagp',
      device: system,
      port: number,
      group: channel.group,
      desirable: channel.mode === 'desirable',
      ...(partner && { partner: { device: partner.system, port: partner.port } }),
    };
    ctx.send(port, { kind: 'ethernet', dst: CDP_MAC, src: hardware.mac, payload: pdu });
  }
}

const txKey = (port: PortId) => `${TIMER_PREFIX} tx ${port}`;
const ageKey = (port: PortId) => `${TIMER_PREFIX} age ${port}`;

/** What changed when the members' states were worked out again. */
export type ChannelChange = {
  readonly membership: boolean;
  readonly up: readonly number[];
  readonly down: readonly number[];
};

/**
 * Works each member's state out again and keeps the conversations going: a port that starts
 * them sends a PDU as it comes up and every period after. Running it again changes nothing.
 */
export function syncChannels(
  ctx: DeviceContext,
  device: Switch,
  state: ChannelState,
): ChannelChange {
  for (const port of [...state.partners.keys()]) {
    const channel = device.config.interfaces[port]?.channelGroup;
    if (!channel || !ctx.portUp(port) || channelProtocol(channel.mode) === undefined) {
      state.partners.delete(port);
      ctx.clearTimer(ageKey(port));
    }
  }
  for (const port of device.ports) {
    const channel = device.config.interfaces[port.id]?.channelGroup;
    const starts = channel?.mode === 'active' || channel?.mode === 'desirable';
    if (!(starts && ctx.portUp(port.id))) {
      if (state.speaking.delete(port.id)) ctx.clearTimer(txKey(port.id));
    } else if (!state.speaking.has(port.id)) {
      // Just up, or just configured: speak at once rather than at the next period.
      state.speaking.add(port.id);
      sendPdu(ctx, device, state, port.id);
      ctx.setTimer(txKey(port.id), PERIOD);
    }
  }
  return refreshFlags(ctx, device, state);
}

function refreshFlags(ctx: DeviceContext, device: Switch, state: ChannelState): ChannelChange {
  const before = new Map(state.flags);
  const wasUp = new Set(state.upSince.keys());
  const next = workOutFlags(ctx, device, state);
  state.flags.clear();
  for (const [port, flag] of next) state.flags.set(port, flag);
  for (const port of [...state.bundledAt.keys()]) {
    if (next.get(port) !== 'P') state.bundledAt.delete(port);
  }
  for (const [port, flag] of next) {
    if (flag === 'P' && !state.bundledAt.has(port)) state.bundledAt.set(port, ctx.now);
  }
  const up: number[] = [];
  const down: number[] = [];
  const groups = channelGroups(device);
  for (const group of new Set([...groups.keys(), ...wasUp])) {
    const inUse = bundled(state, device, group).length > 0;
    if (inUse && !wasUp.has(group)) {
      state.upSince.set(group, ctx.now);
      up.push(group);
    } else if (!inUse && wasUp.has(group)) {
      state.upSince.delete(group);
      down.push(group);
    }
  }
  const membership =
    before.size !== next.size || [...next].some(([port, flag]) => before.get(port) !== flag);
  return { membership, up, down };
}

/** An LACP or PAgP PDU arrived on a port. Returns what changed. */
export function receiveChannelPdu(
  ctx: DeviceContext,
  device: Switch,
  state: ChannelState,
  port: PortId,
  pdu: LacpPdu | PagpPdu,
): ChannelChange | undefined {
  const channel = device.config.interfaces[port]?.channelGroup;
  const protocol = channel && channelProtocol(channel.mode);
  if (!channel || protocol !== pdu.kind) return undefined;
  const partner: Partner =
    pdu.kind === 'lacp'
      ? {
          protocol,
          system: pdu.actor.system,
          port: pdu.actor.port,
          key: pdu.actor.key,
          initiates: pdu.actor.active,
        }
      : {
          protocol,
          system: pdu.device,
          port: pdu.port,
          key: pdu.group,
          initiates: pdu.desirable,
        };
  state.partners.set(port, partner);
  ctx.setTimer(ageKey(port), PARTNER_TIMEOUT);
  // Answer a PDU that does not know this port yet, so the far end learns of it at once.
  const system = systemMac(device);
  const heard = pdu.kind === 'lacp' ? pdu.partner?.system : pdu.partner?.device;
  const heardPort = pdu.partner?.port;
  if (heard !== system || heardPort !== portNumber(device, port)) {
    sendPdu(ctx, device, state, port);
  }
  return refreshFlags(ctx, device, state);
}

/** Runs one of EtherChannel's timers. Undefined for a key that is not EtherChannel's. */
export function onChannelTimer(
  ctx: DeviceContext,
  device: Switch,
  state: ChannelState,
  key: string,
): ChannelChange | undefined {
  const [prefix, kind, port] = key.split(' ') as [string, string, PortId];
  if (prefix !== TIMER_PREFIX) return undefined;
  if (kind === 'tx') {
    sendPdu(ctx, device, state, port);
    ctx.setTimer(key, PERIOD);
    return undefined;
  }
  state.partners.delete(port);
  return refreshFlags(ctx, device, state);
}

/** Every channel group, as `show etherchannel` reports it. */
export function etherchannelStatus(device: Switch, state: ChannelState): EtherChannelStatus[] {
  return [...channelGroups(device)].map(([group, ports]) => {
    const members: ChannelMember[] = ports.map((port) => {
      const mode = device.config.interfaces[port]!.channelGroup!.mode;
      const bundledAt = state.bundledAt.get(port);
      return {
        port,
        mode,
        flag: state.flags.get(port) ?? 'D',
        ...(bundledAt !== undefined && { bundledAt }),
      };
    });
    const upSince = state.upSince.get(group);
    return {
      group,
      protocol: channelProtocol(members[0]!.mode),
      inUse: upSince !== undefined,
      ...(upSince !== undefined && { upSince }),
      members,
    };
  });
}
