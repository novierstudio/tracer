import type { Device, Ipv4Address, MacAddress, Port, PortId, Switchport, VlanId } from '@/model';
import {
  DEFAULT_CDP_HOLDTIME,
  DEFAULT_CDP_TIMER,
  IOS_SOFTWARE,
  LLDP_HOLDTIME,
  LLDP_TIMER,
} from '@/model/l2';
import { after, ms, type SimDuration, type SimTime } from '../core/time';
import type { Frame } from '../frame';
import type { DeviceContext, ModuleContext, SimModule } from '../module';
import { CDP_MAC, LLDP_MAC, type CdpPacket, type DeviceCapability, type LldpPacket } from '../pdu';
import type { CdpNeighbor, DiscoveryStatus, LldpNeighbor } from './status';

/**
 * CDP and LLDP: each up port a protocol runs on advertises the device as it comes up and every
 * period after, and each neighbour heard is kept, by port, for the time its advertisement gives.
 * Routers and switches run both; CDP is on and LLDP off until the config says otherwise.
 */

type IosDevice = Extract<Device, { kind: 'router' | 'switch' }>;

/** What a neighbour last advertised on a port, and when that runs out. */
type Heard<P> = { readonly port: PortId; readonly packet: P; readonly expires: SimTime };

/** One protocol's state: the ports advertising now, and the neighbours heard, by `<port> <sender>`. */
type ProtocolState<P> = {
  readonly advertising: Set<PortId>;
  readonly neighbors: Map<string, Heard<P>>;
};

export type DiscoveryState = {
  readonly cdp: ProtocolState<CdpPacket>;
  readonly lldp: ProtocolState<LldpPacket>;
};

type Ctx = ModuleContext<DiscoveryState>;

/** Under the lab's fast routing timers, both protocols advertise every 5 s. */
const FAST_PERIOD = ms(5_000);

const seconds = (value: number): SimDuration => ms(value * 1000);

const iosDevice = (device: Device): IosDevice | undefined =>
  device.kind === 'router' || device.kind === 'switch' ? device : undefined;

const switchportOf = (device: IosDevice, port: PortId): Switchport | undefined =>
  device.kind === 'switch' ? device.config.interfaces[port]?.switchport : undefined;

const portVlan = (switchport: Switchport): VlanId =>
  switchport.mode === 'access' ? switchport.vlan : switchport.nativeVlan;

/** A multilayer switch with `ip routing` routes as well as switching. */
function capabilitiesOf(device: IosDevice): DeviceCapability[] {
  if (device.kind === 'router') return ['router'];
  return device.config.ipRouting ? ['router', 'switch'] : ['switch'];
}

type Addressed = { readonly ipv4?: { readonly address: Ipv4Address }; readonly shutdown: boolean };

const byName = ([a]: [string, unknown], [b]: [string, unknown]) =>
  a.localeCompare(b, 'en', { numeric: true });

/**
 * The address CDP advertises out of a port: the port's own, or a router's first subinterface's
 * on it, else the device's first. A switch's first is its lowest VLAN interface's; a router's,
 * its first port's in hardware order, then its subinterfaces' and loopbacks'.
 */
function addressOf(device: IosDevice, port: PortId): Ipv4Address | undefined {
  const { interfaces, virtualInterfaces } = device.config;
  const virtual = Object.entries(virtualInterfaces)
    .filter(([id]) => device.kind === 'router' || id.startsWith('Vlan'))
    .sort(byName)
    .map(([, config]) => config);
  const subinterfaces =
    device.kind === 'router' ? Object.entries(device.config.subinterfaces).sort(byName) : [];
  const own = [
    interfaces[port],
    ...subinterfaces.filter(([id]) => id.startsWith(`${port}.`)).map(([, config]) => config),
  ];
  const first =
    device.kind === 'router'
      ? [
          ...device.ports.map((candidate) => interfaces[candidate.id]),
          ...subinterfaces.map(([, config]) => config),
          ...virtual,
        ]
      : virtual;
  const usable = (candidate: Addressed | undefined) => candidate?.ipv4 && !candidate.shutdown;
  return (own.find(usable) ?? first.find(usable))?.ipv4?.address;
}

type EthernetPort = Exclude<Port, { kind: 'serial' }>;

/** How each protocol is configured, what it sends and how it reads what it hears. */
type Protocol<P extends CdpPacket | LldpPacket, T extends Port> = {
  readonly id: 'cdp' | 'lldp';
  readonly mac: MacAddress;
  state(ctx: Ctx): ProtocolState<P>;
  /** The kinds of port the protocol runs on. */
  accepts(port: Port): port is T;
  /** The config lets the port advertise, whether or not its link is up. */
  sends(device: IosDevice, port: PortId): boolean;
  /** The config lets the port keep what it hears. */
  hears(device: IosDevice, port: PortId): boolean;
  period(ctx: DeviceContext, device: IosDevice): SimDuration;
  packet(device: IosDevice, port: T): P;
  /** The frame that carries an advertisement out of the port. */
  frame(port: T, packet: P): Frame;
  /** The packet if a frame carries one of this protocol. */
  read(frame: Frame): P | undefined;
  /** Who sent it: CDP's device ID, LLDP's chassis ID. */
  sender(packet: P): string;
  /** Seconds a neighbour keeps it. */
  keep(packet: P): number;
};

const cdpRuns = (device: IosDevice) => device.config.cdpRun !== false;

const cdpOn = (device: IosDevice, port: PortId) =>
  cdpRuns(device) && device.config.interfaces[port]?.cdpEnable !== false;

const CDP: Protocol<CdpPacket, Port> = {
  id: 'cdp',
  mac: CDP_MAC,
  state: (ctx) => ctx.state.cdp,
  // Ethernet and serial ports alike: over a serial link CDP rides inside Cisco HDLC.
  accepts: (port): port is Port => Boolean(port),
  sends: cdpOn,
  hears: cdpOn,
  period: (ctx, device) =>
    device.config.cdpTimer === undefined && ctx.settings.routingTimers === 'fast'
      ? FAST_PERIOD
      : seconds(device.config.cdpTimer ?? DEFAULT_CDP_TIMER),
  packet(device, port) {
    const address = addressOf(device, port.id);
    const switchport = switchportOf(device, port.id);
    return {
      kind: 'cdp',
      version: 2,
      holdtime: device.config.cdpHoldtime ?? DEFAULT_CDP_HOLDTIME,
      deviceId: device.config.hostname,
      addresses: address ? [address] : [],
      portId: port.id,
      capabilities: capabilitiesOf(device),
      platform: device.model,
      software: IOS_SOFTWARE,
      ...(switchport && { nativeVlan: portVlan(switchport) }),
      duplex: device.config.interfaces[port.id]?.duplex ?? 'full',
    };
  },
  frame: (port, payload) =>
    port.kind === 'serial'
      ? { kind: 'hdlc', payload }
      : { kind: 'ethernet', dst: CDP_MAC, src: port.mac, payload },
  read: (frame) =>
    (frame.kind === 'hdlc' || (frame.kind === 'ethernet' && frame.dst === CDP_MAC)) &&
    frame.payload.kind === 'cdp'
      ? frame.payload
      : undefined,
  sender: (packet) => packet.deviceId,
  keep: (packet) => packet.holdtime,
};

const lldpOn = (device: IosDevice, port: PortId, way: 'lldpTransmit' | 'lldpReceive') =>
  device.config.lldpRun === true && device.config.interfaces[port]?.[way] !== false;

const LLDP: Protocol<LldpPacket, EthernetPort> = {
  id: 'lldp',
  mac: LLDP_MAC,
  state: (ctx) => ctx.state.lldp,
  accepts: (port): port is EthernetPort => port.kind !== 'serial',
  sends: (device, port) => lldpOn(device, port, 'lldpTransmit'),
  hears: (device, port) => lldpOn(device, port, 'lldpReceive'),
  period: (ctx) => (ctx.settings.routingTimers === 'fast' ? FAST_PERIOD : seconds(LLDP_TIMER)),
  packet(device, port) {
    const switchport = switchportOf(device, port.id);
    return {
      kind: 'lldp',
      chassisId: port.mac,
      portId: port.id,
      ttl: LLDP_HOLDTIME,
      systemName: device.config.hostname,
      systemDescription: IOS_SOFTWARE,
      capabilities: capabilitiesOf(device),
      vlan: switchport ? portVlan(switchport) : (1 as VlanId),
    };
  },
  frame: (port, payload) => ({ kind: 'ethernet', dst: LLDP_MAC, src: port.mac, payload }),
  read: (frame) =>
    frame.kind === 'ethernet' && frame.dst === LLDP_MAC && frame.payload.kind === 'lldp'
      ? frame.payload
      : undefined,
  sender: (packet) => packet.chassisId,
  keep: (packet) => packet.ttl,
};

/** The ports the config lets a protocol advertise on, up or not, in hardware order. */
const runsOn = <P extends CdpPacket | LldpPacket, T extends Port>(
  device: IosDevice,
  protocol: Protocol<P, T>,
) =>
  device.ports
    .filter((port) => protocol.accepts(port) && protocol.sends(device, port.id))
    .map((port) => port.id);

const sendKey = (protocol: { readonly id: string }, port: PortId) => `send ${protocol.id} ${port}`;
const SYNC = 'sync';

function advertise<P extends CdpPacket | LldpPacket, T extends Port>(
  ctx: Ctx,
  protocol: Protocol<P, T>,
  port: PortId,
) {
  const device = iosDevice(ctx.device);
  const hardware = ctx.device.ports.find((candidate) => candidate.id === port);
  if (!device || !hardware || !protocol.accepts(hardware)) return;
  ctx.send(port, protocol.frame(hardware, protocol.packet(device, hardware)));
  ctx.setTimer(sendKey(protocol, port), protocol.period(ctx, device));
}

/**
 * Brings each protocol in line with the config and the links: a port that may advertise and is
 * up starts at once, one that may not stops, and neighbours on a port that is down or no longer
 * listens are dropped. Safe to call any number of times.
 */
function sync<P extends CdpPacket | LldpPacket, T extends Port>(
  ctx: Ctx,
  protocol: Protocol<P, T>,
) {
  const device = iosDevice(ctx.device);
  const { advertising, neighbors } = protocol.state(ctx);
  const wanted = new Set(device ? runsOn(device, protocol).filter((port) => ctx.portUp(port)) : []);
  for (const port of advertising) {
    if (wanted.has(port)) continue;
    advertising.delete(port);
    ctx.clearTimer(sendKey(protocol, port));
  }
  for (const port of wanted) {
    if (advertising.has(port)) continue;
    advertising.add(port);
    advertise(ctx, protocol, port);
  }
  for (const [key, heard] of neighbors) {
    if (device && ctx.portUp(heard.port) && protocol.hears(device, heard.port)) continue;
    neighbors.delete(key);
  }
  forgetExpired(ctx, neighbors);
}

/**
 * Drops the neighbours whose advertisements ran out. Expiry is lazy, so a neighbour heard every
 * few seconds costs no timer: every read of the table goes through here or `live`.
 */
function forgetExpired(ctx: DeviceContext, neighbors: Map<string, Heard<unknown>>) {
  for (const [key, heard] of neighbors) if (heard.expires <= ctx.now) neighbors.delete(key);
}

function hear<P extends CdpPacket | LldpPacket, T extends Port>(
  ctx: Ctx,
  protocol: Protocol<P, T>,
  port: PortId,
  packet: P,
) {
  const device = iosDevice(ctx.device);
  if (!device || !ctx.portUp(port) || !protocol.hears(device, port)) return;
  const key = `${port} ${protocol.sender(packet)}`;
  const { neighbors } = protocol.state(ctx);
  forgetExpired(ctx, neighbors);
  neighbors.set(key, { port, packet, expires: after(ctx.now, seconds(protocol.keep(packet))) });
}

/** A port's next advertisement is due. */
function onSendTimer<P extends CdpPacket | LldpPacket, T extends Port>(
  ctx: Ctx,
  protocol: Protocol<P, T>,
  port: PortId,
) {
  if (protocol.state(ctx).advertising.has(port)) advertise(ctx, protocol, port);
}

const syncAll = (ctx: Ctx) => {
  sync(ctx, CDP);
  sync(ctx, LLDP);
};

const emptyProtocol = () => ({ advertising: new Set<PortId>(), neighbors: new Map() });

export const discoveryModule: SimModule<DiscoveryState> = {
  id: 'discovery',
  init: (ctx) => {
    // Links come up before the module starts, so the first advertisements wait for its timer.
    ctx.setTimer(SYNC, ms(0));
    return { cdp: emptyProtocol(), lldp: emptyProtocol() };
  },
  onFrame(ctx, port, frame) {
    const cdp = CDP.read(frame);
    if (cdp) return hear(ctx, CDP, port, cdp);
    const lldp = LLDP.read(frame);
    if (lldp) hear(ctx, LLDP, port, lldp);
  },
  onTimer(ctx, key) {
    if (key === SYNC) return syncAll(ctx);
    const [, id, port] = key.split(' ') as [string, string, PortId];
    if (id === CDP.id) onSendTimer(ctx, CDP, port);
    else if (id === LLDP.id) onSendTimer(ctx, LLDP, port);
  },
  onLinkChange: syncAll,
  onConfigChange: syncAll,
};

/** Seconds left before an entry runs out, rounded up so a live entry never shows 0. */
const remaining = (ctx: DeviceContext, expires: SimTime) =>
  Math.max(0, Math.ceil((expires - ctx.now) / 1000));

/** The neighbours whose advertisements have not run out, in the order they were first heard. */
const live = <P>(ctx: DeviceContext, neighbors: Map<string, Heard<P>>) =>
  [...neighbors.values()].filter((heard) => heard.expires > ctx.now);

export function discoveryStatus(ctx: Ctx): DiscoveryStatus {
  const device = iosDevice(ctx.device);
  const config = device?.config;
  const cdpNeighbors = live(ctx, ctx.state.cdp.neighbors).map(
    ({ port, packet, expires }): CdpNeighbor => ({
      deviceId: packet.deviceId,
      localPort: port,
      holdtime: remaining(ctx, expires),
      capabilities: packet.capabilities,
      platform: packet.platform,
      portId: packet.portId,
      addresses: packet.addresses,
      software: packet.software,
      version: packet.version,
      ...(packet.nativeVlan !== undefined && { nativeVlan: packet.nativeVlan }),
      duplex: packet.duplex,
    }),
  );
  const lldpNeighbors = live(ctx, ctx.state.lldp.neighbors).map(
    ({ port, packet, expires }): LldpNeighbor => ({
      chassisId: packet.chassisId,
      localPort: port,
      holdtime: remaining(ctx, expires),
      ttl: packet.ttl,
      portId: packet.portId,
      systemName: packet.systemName,
      systemDescription: packet.systemDescription,
      capabilities: packet.capabilities,
      ...(packet.managementAddress !== undefined && {
        managementAddress: packet.managementAddress,
      }),
      ...(packet.vlan !== undefined && { vlan: packet.vlan }),
    }),
  );
  return {
    cdp: {
      enabled: device ? cdpRuns(device) : false,
      timer: config?.cdpTimer ?? DEFAULT_CDP_TIMER,
      holdtime: config?.cdpHoldtime ?? DEFAULT_CDP_HOLDTIME,
      interfaces: device ? runsOn(device, CDP) : [],
      neighbors: cdpNeighbors,
    },
    lldp: {
      enabled: config?.lldpRun === true,
      timer: LLDP_TIMER,
      holdtime: LLDP_HOLDTIME,
      neighbors: lldpNeighbors,
    },
  };
}
