import type { Device, PortId, StpTimers, VlanId } from '@/model';
import { carriesVlan, DEFAULT_BRIDGE_PRIORITY } from '@/model/vlans';
import { ms, type SimDuration, type SimTime } from '../core/time';
import type { DeviceContext } from '../module';
import { UNKNOWN_MAC, type Bpdu, type BridgeId, type ConfigBpdu, type StpPortId } from '../pdu';

/**
 * 802.1D spanning tree, one instance per VLAN as Cisco's PVST+ runs it. The switching module owns
 * this state and calls in here: the bridge relay reads each port's state before it learns from or
 * forwards a frame, and ages its addresses quickly while the root reports a topology change.
 */

type Switch = Extract<Device, { kind: 'switch' }>;

/** The timers a bridge runs by, in seconds. The root's go out in its BPDUs, and every bridge adopts them. */
export type StpTimes = {
  readonly hello: number;
  readonly maxAge: number;
  readonly forwardDelay: number;
};

/**
 * Tracer's default: a new port listens for 2 s and learns for 2 s, so a lab pings within seconds.
 * Only forward delay stands between a new port and forwarding, so hello stays at the IOS 2 s and
 * a lab sends no more BPDUs than on the real timers.
 *
 * 802.1D asks for max age >= 2 x (hello + 1), so the root's information outlives a lost hello:
 * 8 >= 6 holds. It also asks for 2 x (forward delay - 1) >= max age, so the information about a
 * failed path has aged out across the network before a port that replaces it forwards, allowing
 * a second per hop for BPDUs to cross it: 2 >= 8 does not hold. Tracer moves a BPDU across a hop
 * in 1 ms and never loses one, so news of a change reaches every bridge within one forward delay.
 *
 * Each bridge adds 1 to a BPDU's message age, and a bridge drops the root's information when the
 * next hello would arrive too late, so bridges up to 6 hops from the root keep hearing it. That
 * is a line of 7 switches with the root at one end, the diameter IOS plans its own defaults for.
 */
const FAST_TIMES: StpTimes = { hello: 2, maxAge: 8, forwardDelay: 2 };

/** The timers each bridge is configured with, by the lab's setting: 4 s or 30 s to forwarding. */
export const STP_TIMES: Record<StpTimers, StpTimes> = {
  ios: { hello: 2, maxAge: 20, forwardDelay: 15 },
  fast: FAST_TIMES,
};

const PORT_PRIORITY = 128;

/** Path cost by speed in Mbit/s: the short costs of 802.1D-1998, as IOS uses by default. */
const SPEED_COST = { 10: 100, 100: 19, 1000: 4 } as const;

/** A port that does not block forwards only after a listening and a learning forward delay. */
export type PortState = 'blocking' | 'listening' | 'learning' | 'forwarding';

/** Alternate and backup ports block. A backup port hears this bridge's own BPDUs from another port. */
export type PortRole = 'root' | 'designated' | 'alternate' | 'backup';

/** The best path to the root that a port has heard of, from the designated bridge on its segment. */
type Offer = {
  readonly root: BridgeId;
  readonly cost: number;
  readonly bridge: BridgeId;
  readonly port: StpPortId;
};

type Port = {
  /** A neighbour's offer from its BPDUs, or this bridge's own while the port is designated. */
  offer: Offer;
  /** When the offer came from a BPDU: its message age and when it arrived, so it can age out. */
  heard: { readonly messageAge: number; readonly at: SimTime } | undefined;
  state: PortState;
  /** A TCN arrived on this designated port, and the next config BPDU out of it acknowledges it. */
  ackTcn: boolean;
};

/** One VLAN's spanning tree on this switch. The bridge is the root while it has no root port. */
export type Instance = {
  readonly vlan: VlanId;
  /** This bridge's identity as its designated ports last advertised it. */
  bridge: BridgeId;
  root: BridgeId;
  rootCost: number;
  rootPort: PortId | undefined;
  /** The root's timers, which every bridge in the tree runs by. */
  times: StpTimes;
  /** The root reports a topology change: learned addresses age out after forward delay. */
  topologyChange: boolean;
  /** This bridge saw a topology change and sends TCNs toward the root until one is acknowledged. */
  notifying: boolean;
  readonly ports: Map<PortId, Port>;
};

/** Spanning tree instances by VLAN: one for each VLAN that exists and an up port carries. */
export type StpState = Map<VlanId, Instance>;

/** What spanning tree needs from the switch it runs on. */
export interface StpContext extends Pick<
  DeviceContext,
  'now' | 'settings' | 'portUp' | 'setTimer' | 'clearTimer' | 'note'
> {
  readonly device: Switch;
  /** Sends a BPDU out of a port as a frame of `vlan`, tagged as the port needs. */
  sendBpdu(port: PortId, vlan: VlanId, bpdu: Bpdu): void;
}

type Timer =
  | { readonly kind: 'hello' | 'tcn' | 'tc'; readonly vlan: VlanId }
  | { readonly kind: 'age' | 'forward'; readonly vlan: VlanId; readonly port: PortId };

const TIMER_PREFIX = 'stp';

function timerKey(timer: Timer): string {
  const base = `${TIMER_PREFIX} ${timer.kind} ${timer.vlan}`;
  return 'port' in timer ? `${base} ${timer.port}` : base;
}

function parseTimer(key: string): Timer | undefined {
  const [prefix, kind, vlanText, port] = key.split(' ');
  if (prefix !== TIMER_PREFIX) return undefined;
  const vlan = Number(vlanText) as VlanId;
  switch (kind) {
    case 'hello':
    case 'tcn':
    case 'tc':
      return { kind, vlan };
    case 'age':
    case 'forward':
      return port === undefined ? undefined : { kind, vlan, port: port as PortId };
    default:
      return undefined;
  }
}

const seconds = (value: number): SimDuration => ms(value * 1000);

/** The timers the lab configures this bridge with. It runs by them while it is the root. */
const ownTimes = (ctx: StpContext) => STP_TIMES[ctx.settings.stpTimers];

function compareBridges(a: BridgeId, b: BridgeId): number {
  return a.priority - b.priority || (a.mac < b.mac ? -1 : a.mac > b.mac ? 1 : 0);
}

const sameBridge = (a: BridgeId, b: BridgeId) => compareBridges(a, b) === 0;

const comparePorts = (a: StpPortId, b: StpPortId) => a.priority - b.priority || a.number - b.number;

/** A switch's bridge address is its first Ethernet MAC, as its VLAN interface's is. */
function bridgeMac(device: Switch) {
  for (const port of device.ports) if (port.kind !== 'serial') return port.mac;
  return UNKNOWN_MAC;
}

export function bridgeId(device: Switch, vlan: VlanId): BridgeId {
  const priority = device.config.stpPriorities?.[vlan] ?? DEFAULT_BRIDGE_PRIORITY;
  return { priority: priority + vlan, mac: bridgeMac(device) };
}

/** Ports are numbered from 1 in hardware order, so Fa0/1 is 1 and a 24-port switch's Gi0/1 is 25. */
export function portId(device: Switch, port: PortId): StpPortId {
  return { priority: PORT_PRIORITY, number: device.ports.findIndex((p) => p.id === port) + 1 };
}

/** `spanning-tree cost`, or else the cost of the port's set speed, or else of its fastest. */
export function pathCost(device: Switch, port: PortId): number {
  const config = device.config.interfaces[port];
  if (config?.stpCost !== undefined) return config.stpCost;
  const kind = device.ports.find((p) => p.id === port)?.kind;
  return SPEED_COST[config?.speed ?? (kind === 'gigabitEthernet' ? 1000 : 100)];
}

/** PortFast takes effect on an access port only, as on IOS. */
export function isEdge(device: Switch, port: PortId): boolean {
  const config = device.config.interfaces[port];
  return config?.portfast === true && config.switchport?.mode === 'access';
}

const isRoot = (instance: Instance) => instance.rootPort === undefined;

/** The offer this bridge makes on a segment where it is the designated bridge. */
function ownOffer(device: Switch, instance: Instance, port: PortId): Offer {
  const { root, rootCost: cost } = instance;
  return { root, cost, bridge: instance.bridge, port: portId(device, port) };
}

/** Whether this bridge is the designated bridge on the port's segment. */
function designatedHere(device: Switch, instance: Instance, id: PortId, port: Port): boolean {
  return (
    sameBridge(port.offer.bridge, instance.bridge) &&
    comparePorts(port.offer.port, portId(device, id)) === 0
  );
}

function roleOf(device: Switch, instance: Instance, id: PortId, port: Port): PortRole {
  if (id === instance.rootPort) return 'root';
  if (designatedHere(device, instance, id, port)) return 'designated';
  return sameBridge(port.offer.bridge, instance.bridge) ? 'backup' : 'alternate';
}

/** A path to the root through one port, in the order 802.1D compares them: lowest wins. */
type Candidate = { id: PortId; offer: Offer; cost: number; own: StpPortId };

const compareCandidates = (a: Candidate, b: Candidate) =>
  compareBridges(a.offer.root, b.offer.root) ||
  a.cost - b.cost ||
  compareBridges(a.offer.bridge, b.offer.bridge) ||
  comparePorts(a.offer.port, b.offer.port) ||
  comparePorts(a.own, b.own);

function setState(ctx: StpContext, instance: Instance, id: PortId, port: Port, state: PortState) {
  port.state = state;
  ctx.note(`${id} in VLAN ${instance.vlan} is ${state}`);
}

/** Every VLAN that exists on the switch and an up port carries, with those ports in hardware order. */
function participants(ctx: StpContext): Map<VlanId, PortId[]> {
  const { device } = ctx;
  const found = new Map<VlanId, PortId[]>();
  const vlans = Object.keys(device.config.vlans)
    .map((id) => Number(id) as VlanId)
    .sort((a, b) => a - b);
  for (const vlan of vlans) {
    const ports = device.ports.flatMap((port) => {
      const switchport = device.config.interfaces[port.id]?.switchport;
      return switchport && carriesVlan(switchport, vlan) && ctx.portUp(port.id) ? [port.id] : [];
    });
    if (ports.length > 0) found.set(vlan, ports);
  }
  return found;
}

function transmitConfig(ctx: StpContext, instance: Instance, id: PortId, port: Port) {
  const heard = instance.rootPort && instance.ports.get(instance.rootPort)?.heard;
  const messageAge = heard ? heard.messageAge + Math.floor((ctx.now - heard.at) / 1000) + 1 : 0;
  if (messageAge >= instance.times.maxAge) return;
  const bpdu: ConfigBpdu = {
    kind: 'bpdu',
    type: 'config',
    root: instance.root,
    rootPathCost: instance.rootCost,
    bridge: instance.bridge,
    port: portId(ctx.device, id),
    messageAge,
    maxAge: instance.times.maxAge,
    helloTime: instance.times.hello,
    forwardDelay: instance.times.forwardDelay,
    topologyChange: instance.topologyChange,
    topologyChangeAck: port.ackTcn,
  };
  port.ackTcn = false;
  ctx.sendBpdu(id, instance.vlan, bpdu);
}

/** Sends a config BPDU out of every port where this bridge is the designated bridge. */
function generateConfig(ctx: StpContext, instance: Instance) {
  for (const [id, port] of instance.ports) {
    if (designatedHere(ctx.device, instance, id, port)) transmitConfig(ctx, instance, id, port);
  }
}

/** The root sends config BPDUs now and every hello time after. */
function sendHello(ctx: StpContext, instance: Instance) {
  generateConfig(ctx, instance);
  ctx.setTimer(timerKey({ kind: 'hello', vlan: instance.vlan }), seconds(ownTimes(ctx).hello));
}

function sendTcn(ctx: StpContext, instance: Instance) {
  if (!instance.rootPort) return;
  ctx.sendBpdu(instance.rootPort, instance.vlan, { kind: 'bpdu', type: 'tcn' });
}

/**
 * The root flags a topology change in its BPDUs for max age plus forward delay. Any other bridge
 * tells the root, with a TCN every hello time until its designated bridge acknowledges one.
 */
function detectTopologyChange(ctx: StpContext, instance: Instance) {
  const { vlan } = instance;
  if (isRoot(instance)) {
    instance.topologyChange = true;
    const { maxAge, forwardDelay } = ownTimes(ctx);
    const period = seconds(maxAge + forwardDelay);
    ctx.setTimer(timerKey({ kind: 'tc', vlan }), period);
  } else if (!instance.notifying) {
    instance.notifying = true;
    sendTcn(ctx, instance);
    ctx.setTimer(timerKey({ kind: 'tcn', vlan }), seconds(ownTimes(ctx).hello));
  }
}

function makeForwarding(ctx: StpContext, instance: Instance, id: PortId, port: Port) {
  if (port.state !== 'blocking') return;
  if (isEdge(ctx.device, id)) {
    setState(ctx, instance, id, port, 'forwarding');
    return;
  }
  setState(ctx, instance, id, port, 'listening');
  const delay = seconds(instance.times.forwardDelay);
  ctx.setTimer(timerKey({ kind: 'forward', vlan: instance.vlan, port: id }), delay);
}

/** Whether a port leaving forwarding or learning changes the topology: not at the network's edge. */
const changesTopology = (device: Switch, id: PortId, port: Port) =>
  (port.state === 'forwarding' || port.state === 'learning') && !isEdge(device, id);

/** Blocks the port. Returns whether that changed the topology. */
function makeBlocking(ctx: StpContext, instance: Instance, id: PortId, port: Port): boolean {
  if (port.state === 'blocking') return false;
  const changed = changesTopology(ctx.device, id, port);
  setState(ctx, instance, id, port, 'blocking');
  ctx.clearTimer(timerKey({ kind: 'forward', vlan: instance.vlan, port: id }));
  return changed;
}

/** The bridge's priority changed: re-sign the offers on its designated ports. */
function adoptBridgeId(ctx: StpContext, instance: Instance) {
  const next = bridgeId(ctx.device, instance.vlan);
  if (sameBridge(next, instance.bridge)) return;
  const root = isRoot(instance);
  for (const [id, port] of instance.ports) {
    if (!designatedHere(ctx.device, instance, id, port)) continue;
    port.offer = { ...port.offer, bridge: next, ...(root && { root: next }) };
  }
  if (root) instance.root = next;
  instance.bridge = next;
}

/**
 * 802.1D's configuration update and port state selection. The root port is the one with the best
 * path to a root better than this bridge; this bridge is designated on each segment where its own
 * offer beats the one it has heard. Root and designated ports head for forwarding, the rest block.
 * `changed` says the caller already changed the topology, as by dropping a forwarding port.
 */
function reselect(ctx: StpContext, instance: Instance, changed = false) {
  const { device } = ctx;
  const { vlan, bridge: me } = instance;
  const wasRoot = isRoot(instance);

  let best: Candidate | undefined;
  for (const [id, port] of instance.ports) {
    if (designatedHere(device, instance, id, port)) continue;
    if (compareBridges(port.offer.root, me) >= 0) continue;
    const cost = port.offer.cost + pathCost(device, id);
    const candidate = { id, offer: port.offer, cost, own: portId(device, id) };
    if (!best || compareCandidates(candidate, best) < 0) best = candidate;
  }
  instance.root = best ? best.offer.root : me;
  instance.rootCost = best ? best.cost : 0;
  instance.rootPort = best?.id;

  for (const [id, port] of instance.ports) {
    if (id === instance.rootPort) continue;
    const { offer } = port;
    const designated =
      designatedHere(device, instance, id, port) ||
      !sameBridge(offer.root, instance.root) ||
      instance.rootCost < offer.cost ||
      (instance.rootCost === offer.cost &&
        (compareBridges(me, offer.bridge) < 0 ||
          (sameBridge(me, offer.bridge) && comparePorts(portId(device, id), offer.port) <= 0)));
    if (!designated) continue;
    port.offer = ownOffer(device, instance, id);
    port.heard = undefined;
    ctx.clearTimer(timerKey({ kind: 'age', vlan, port: id }));
  }

  let topologyChanged = changed;
  for (const [id, port] of instance.ports) {
    const role = roleOf(device, instance, id, port);
    if (role === 'root' || role === 'designated') makeForwarding(ctx, instance, id, port);
    else topologyChanged = makeBlocking(ctx, instance, id, port) || topologyChanged;
  }

  const nowRoot = isRoot(instance);
  if (wasRoot && !nowRoot) {
    ctx.note(`VLAN ${vlan}: the root is now ${instance.root.priority} ${instance.root.mac}`);
    ctx.clearTimer(timerKey({ kind: 'hello', vlan }));
    if (instance.topologyChange) {
      // The change this bridge was announcing as root goes to the new root instead.
      ctx.clearTimer(timerKey({ kind: 'tc', vlan }));
      topologyChanged = true;
    }
  } else if (!wasRoot && nowRoot) {
    ctx.note(`VLAN ${vlan}: this bridge is now the root`);
    instance.times = ownTimes(ctx);
    instance.notifying = false;
    ctx.clearTimer(timerKey({ kind: 'tcn', vlan }));
    topologyChanged = true;
  }
  if (topologyChanged) detectTopologyChange(ctx, instance);
  if (!wasRoot && nowRoot) sendHello(ctx, instance);
}

/** Takes a port out of the instance. Returns whether that changed the topology. */
function dropPort(ctx: StpContext, instance: Instance, id: PortId): boolean {
  const port = instance.ports.get(id);
  if (!port) return false;
  instance.ports.delete(id);
  ctx.clearTimer(timerKey({ kind: 'age', vlan: instance.vlan, port: id }));
  ctx.clearTimer(timerKey({ kind: 'forward', vlan: instance.vlan, port: id }));
  return changesTopology(ctx.device, id, port);
}

function dropInstance(ctx: StpContext, instance: Instance) {
  for (const id of [...instance.ports.keys()]) dropPort(ctx, instance, id);
  for (const kind of ['hello', 'tcn', 'tc'] as const) {
    ctx.clearTimer(timerKey({ kind, vlan: instance.vlan }));
  }
}

/** A new instance starts as its own root, with no ports yet. */
function createInstance(ctx: StpContext, vlan: VlanId): Instance {
  const bridge = bridgeId(ctx.device, vlan);
  return {
    vlan,
    bridge,
    root: bridge,
    rootCost: 0,
    rootPort: undefined,
    times: ownTimes(ctx),
    topologyChange: false,
    notifying: false,
    ports: new Map(),
  };
}

/**
 * Brings the instances in line with the switch's config and link state: an instance for each VLAN
 * that exists and has an up port, holding exactly those ports. A port that joins starts out
 * blocking, as the designated port for its segment. Running it again changes nothing.
 */
export function syncStp(ctx: StpContext, stp: StpState) {
  const wanted = participants(ctx);
  for (const [vlan, instance] of stp) {
    if (wanted.has(vlan)) continue;
    dropInstance(ctx, instance);
    stp.delete(vlan);
  }
  for (const [vlan, ports] of wanted) {
    const existing = stp.get(vlan);
    const instance = existing ?? createInstance(ctx, vlan);
    stp.set(vlan, instance);
    let changed = false;
    for (const id of [...instance.ports.keys()]) {
      if (!ports.includes(id)) changed = dropPort(ctx, instance, id) || changed;
    }
    for (const id of ports) {
      if (instance.ports.has(id)) continue;
      const offer = ownOffer(ctx.device, instance, id);
      instance.ports.set(id, { offer, heard: undefined, state: 'blocking', ackTcn: false });
    }
    adoptBridgeId(ctx, instance);
    // A root runs by its own timers, so it picks up a change to the lab's setting here.
    if (isRoot(instance)) instance.times = ownTimes(ctx);
    reselect(ctx, instance, changed);
    if (!existing) sendHello(ctx, instance);
  }
}

/** 802.1D's test for whether a config BPDU replaces what the port has heard. */
function supersedes(bpdu: ConfigBpdu, heard: Offer, me: BridgeId): boolean {
  const byRoot = compareBridges(bpdu.root, heard.root);
  if (byRoot !== 0) return byRoot < 0;
  if (bpdu.rootPathCost !== heard.cost) return bpdu.rootPathCost < heard.cost;
  const byBridge = compareBridges(bpdu.bridge, heard.bridge);
  if (byBridge !== 0) return byBridge < 0;
  return !sameBridge(bpdu.bridge, me) || comparePorts(bpdu.port, heard.port) <= 0;
}

/** A BPDU arrived on a port as a frame of `vlan`. */
export function receiveBpdu(ctx: StpContext, stp: StpState, vlan: VlanId, id: PortId, bpdu: Bpdu) {
  const instance = stp.get(vlan);
  const port = instance?.ports.get(id);
  if (!instance || !port) return;

  if (bpdu.type === 'tcn') {
    if (!designatedHere(ctx.device, instance, id, port)) return;
    detectTopologyChange(ctx, instance);
    port.ackTcn = true;
    transmitConfig(ctx, instance, id, port);
    return;
  }

  if (bpdu.messageAge >= bpdu.maxAge) return;
  if (!supersedes(bpdu, port.offer, instance.bridge)) {
    // Tell a bridge that claims a worse path what this segment's designated bridge offers.
    if (designatedHere(ctx.device, instance, id, port)) transmitConfig(ctx, instance, id, port);
    return;
  }

  port.offer = { root: bpdu.root, cost: bpdu.rootPathCost, bridge: bpdu.bridge, port: bpdu.port };
  port.heard = { messageAge: bpdu.messageAge, at: ctx.now };
  ctx.setTimer(timerKey({ kind: 'age', vlan, port: id }), seconds(bpdu.maxAge - bpdu.messageAge));
  reselect(ctx, instance);
  if (id !== instance.rootPort) return;

  instance.times = {
    hello: bpdu.helloTime,
    maxAge: bpdu.maxAge,
    forwardDelay: bpdu.forwardDelay,
  };
  instance.topologyChange = bpdu.topologyChange;
  generateConfig(ctx, instance);
  if (bpdu.topologyChangeAck && instance.notifying) {
    instance.notifying = false;
    ctx.clearTimer(timerKey({ kind: 'tcn', vlan }));
  }
}

/** Runs one of spanning tree's timers. A key that is not spanning tree's does nothing. */
export function onStpTimer(ctx: StpContext, stp: StpState, key: string) {
  const timer = parseTimer(key);
  const instance = timer && stp.get(timer.vlan);
  if (!timer || !instance) return;
  switch (timer.kind) {
    case 'hello':
      sendHello(ctx, instance);
      return;
    case 'tcn':
      sendTcn(ctx, instance);
      ctx.setTimer(key, seconds(ownTimes(ctx).hello));
      return;
    case 'tc':
      instance.topologyChange = false;
      return;
    case 'age': {
      // Nothing heard from the segment's designated bridge for max age: take the segment over.
      const port = instance.ports.get(timer.port);
      if (!port) return;
      port.offer = ownOffer(ctx.device, instance, timer.port);
      port.heard = undefined;
      reselect(ctx, instance);
      return;
    }
    case 'forward': {
      const port = instance.ports.get(timer.port);
      if (port?.state === 'listening') {
        setState(ctx, instance, timer.port, port, 'learning');
        ctx.setTimer(key, seconds(instance.times.forwardDelay));
      } else if (port?.state === 'learning') {
        setState(ctx, instance, timer.port, port, 'forwarding');
        const designated = [...instance.ports].some(([id, p]) =>
          designatedHere(ctx.device, instance, id, p),
        );
        if (designated) detectTopologyChange(ctx, instance);
      }
      return;
    }
  }
}

/** The port's state in the VLAN's tree, or undefined where no tree runs: the bridge drops those frames. */
export function portState(stp: StpState, vlan: VlanId, port: PortId): PortState | undefined {
  return stp.get(vlan)?.ports.get(port)?.state;
}

/** A port spanning tree runs on that forwards in none of its VLANs, as its link light shows. */
export function isHeld(stp: StpState, port: PortId): boolean {
  let member = false;
  for (const instance of stp.values()) {
    const state = instance.ports.get(port)?.state;
    if (state === 'forwarding') return false;
    member ||= state !== undefined;
  }
  return member;
}

export type SpanningTreePort = {
  readonly port: PortId;
  readonly id: StpPortId;
  readonly role: PortRole;
  readonly state: PortState;
  readonly cost: number;
  /** PortFast in effect. */
  readonly edge: boolean;
};

/** One VLAN's tree as `show spanning-tree` reports it. */
export type SpanningTreeVlan = {
  readonly vlan: VlanId;
  readonly root: BridgeId;
  readonly rootCost: number;
  readonly rootPort: { readonly port: PortId; readonly id: StpPortId } | undefined;
  readonly bridge: BridgeId;
  /** The root's timers, which the bridge runs by. */
  readonly times: StpTimes;
  /** The bridge's own timers, from the lab's setting: what it would send as the root. */
  readonly bridgeTimes: StpTimes;
  /** How long a learned address stays, in seconds: forward delay during a topology change. */
  readonly agingTime: number;
  readonly ports: readonly SpanningTreePort[];
};

/** Every instance on the switch, by VLAN, with its ports in hardware order. */
export function spanningTree(
  device: Switch,
  stp: StpState,
  bridgeTimes: StpTimes,
  agingTime: (instance: Instance) => number,
): SpanningTreeVlan[] {
  const instances = [...stp.values()].sort((a, b) => a.vlan - b.vlan);
  return instances.map((instance) => ({
    vlan: instance.vlan,
    root: instance.root,
    rootCost: instance.rootCost,
    rootPort: instance.rootPort && {
      port: instance.rootPort,
      id: portId(device, instance.rootPort),
    },
    bridge: instance.bridge,
    times: instance.times,
    bridgeTimes,
    agingTime: agingTime(instance),
    ports: [...instance.ports]
      .map(([id, port]) => ({
        port: id,
        id: portId(device, id),
        role: roleOf(device, instance, id, port),
        state: port.state,
        cost: pathCost(device, id),
        edge: isEdge(device, id),
      }))
      .sort((a, b) => a.id.number - b.id.number),
  }));
}
