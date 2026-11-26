import type {
  Device,
  EigrpConfig,
  EigrpNetwork,
  InterfaceId,
  Ipv4Address,
  Ipv4Cidr,
  MacAddress,
  RoutingTimers,
} from '@/model';
import { ms, type SimDuration, type SimTime } from '../../core/time';
import { ipInterfaces, type IpInterface } from '../../l3/interfaces';
import {
  classfulNetwork,
  compareAddresses,
  inPrefix,
  matchesWildcard,
  networkOf,
} from '../../l3/ipv4';
import { ADMINISTRATIVE_DISTANCE, MAXIMUM_PATHS, type LearnedRoute } from '../../l3/routes';
import type { DeviceContext, ModuleContext, SimModule } from '../../module';
import {
  EIGRP_GROUP,
  type EigrpExternal,
  type EigrpKValues,
  type EigrpMetric,
  type EigrpPacket,
  type EigrpRoute,
  type EigrpRouting,
} from '../../pdu';
import { bandwidthOf, delayOf, pickRouterId } from '../interfaceMetrics';
import { arrival, packetIn, sendOn } from '../link';
import { EIGRP_TIMERS } from '../timers';
import {
  compositeMetric,
  connectedMetric,
  DEFAULT_K_VALUES,
  INFINITE_METRIC,
  isUnreachable,
  throughLink,
  unreachableMetric,
  type Link,
} from './metric';
import type { EigrpPathStatus, EigrpStatus, EigrpTopologyEntry } from './status';

/**
 * EIGRP for IPv4 as IOS runs it, by RFC 7868. Routers find neighbours with hellos and trade
 * their tables in reliable updates, each acked. Every router keeps each neighbour's reported
 * distance to every destination in its topology table and runs DUAL over it: the best path is
 * the successor, and a neighbour whose reported distance is below the feasible distance, the
 * best distance so far, is a feasible successor that cannot loop back. When the successor goes,
 * a feasible successor takes over at once. With none, the router goes active: it queries every
 * neighbour and picks the best path once they have all replied.
 */

type Router = Extract<Device, { kind: 'router' }>;

/** EIGRP on one interface. */
type Iface = {
  readonly name: InterfaceId;
  /** The working interface it runs on, as the IP stack derives it. */
  ip: IpInterface;
  /** No hellos out, none taken in, so no neighbours; its network is still advertised. */
  passive: boolean;
  /** What the interface adds to a path through it. */
  link: Link;
};

type Neighbor = {
  /** Its interface and address, which name it: see `neighborKey`. */
  readonly key: string;
  readonly address: Ipv4Address;
  readonly interface: InterfaceId;
  /** The MAC its packets came from, for unicast on a LAN. */
  mac: MacAddress | undefined;
  /** The H column of `show ip eigrp neighbors`: the lowest number free when it came up. */
  readonly handle: number;
  /** Seconds, from its last hello. */
  holdTime: number;
  holdUntil: SimTime;
  readonly upAt: SimTime;
  /** The sequence number of the last reliable packet it sent. */
  sequence: number;
  /** Its INIT update arrived: it asked for this router's table and got it. */
  initReceived: boolean;
  /** When it last sent routes, for `show ip protocols`. */
  lastUpdateAt: SimTime | undefined;
};

/** What one neighbour last said of a destination: its own metric to it. */
type Report = { readonly metric: EigrpMetric; readonly external: EigrpExternal | undefined };

/** A destination this router originates: a network of its own, or a static route it redistributes. */
type Origin =
  | { readonly kind: 'connected'; readonly interface: InterfaceId; readonly metric: EigrpMetric }
  | {
      readonly kind: 'redistributed';
      readonly metric: EigrpMetric;
      readonly external: EigrpExternal;
    };

type Destination = {
  readonly prefix: Ipv4Cidr;
  origin: Origin | undefined;
  /** By neighbour key. Only reachable ones: a withdrawn route is no report. */
  readonly reports: Map<string, Report>;
  /** The feasible distance: the distance through the successors. INFINITE_METRIC when lost. */
  fd: number;
  /** The neighbour keys of the paths in use. Empty for an origin. */
  successors: string[];
  /** While active: the neighbours yet to reply, and the one whose query sent it active. */
  active: { readonly awaiting: Set<string>; readonly queriedBy: string | undefined } | undefined;
  /** What each interface's neighbours last heard of it, for split horizon and withdrawals. */
  readonly told: Map<InterfaceId, EigrpRoute>;
  /** When its successors last changed, as `show ip route` ages the route. */
  since: SimTime;
};

type Process = {
  readonly asn: number;
  readonly routerId: Ipv4Address;
  /** The `eigrp router-id` it started with: changing it restarts the process. */
  readonly configuredId: Ipv4Address | undefined;
  readonly profile: RoutingTimers;
  readonly kValues: EigrpKValues;
  readonly interfaces: Map<InterfaceId, Iface>;
  readonly neighbors: Map<string, Neighbor>;
  /** By network as `10.1.0.0/16`. */
  readonly destinations: Map<string, Destination>;
  /** Destinations changed since updates last went out. */
  readonly changed: Set<string>;
  /** Queries to send out of each interface, and replies to each neighbour, once the event is done. */
  readonly queries: Map<InterfaceId, EigrpRoute[]>;
  readonly replies: Map<string, EigrpRoute[]>;
  /** The last sequence number this router gave a reliable packet. */
  sequence: number;
};

export type EigrpState = { process: Process | undefined; nextPacketId: number };

type EigrpContext = ModuleContext<EigrpState>;

type Timer =
  | { readonly kind: 'start' }
  | { readonly kind: 'hello'; readonly iface: InterfaceId }
  | { readonly kind: 'hold'; readonly neighbor: string };

function timerKey(timer: Timer): string {
  switch (timer.kind) {
    case 'start':
      return 'eigrp start';
    case 'hello':
      return `eigrp hello ${timer.iface}`;
    case 'hold':
      return `eigrp hold ${timer.neighbor}`;
  }
}

function parseTimer(key: string): Timer | undefined {
  const [prefix, kind, ...rest] = key.split(' ');
  if (prefix !== 'eigrp') return undefined;
  switch (kind) {
    case 'start':
      return { kind };
    case 'hello':
      return { kind, iface: rest.join(' ') as InterfaceId };
    case 'hold':
      return { kind, neighbor: rest.join(' ') };
    default:
      return undefined;
  }
}

/** EIGRP packets live two hops, as IOS sends them: they never need to leave the link. */
const EIGRP_TTL = 2;

const seconds = (value: number): SimDuration => ms(value * 1000);
const timersOf = (ctx: DeviceContext) => EIGRP_TIMERS[ctx.settings.routingTimers];
const keyOf = ({ address, prefixLength }: Ipv4Cidr) => `${address}/${prefixLength}`;
const neighborKey = (iface: InterfaceId, address: Ipv4Address) => `${iface} ${address}`;
const eigrpConfig = (device: Device): EigrpConfig | undefined =>
  device.kind === 'router' ? device.config.eigrp : undefined;
const sameK = (a: EigrpKValues, b: EigrpKValues) => a.every((k, i) => k === b[i]);
const reachable = (d: Destination) => d.origin !== undefined || d.successors.length > 0;

/** Whether a `network` command covers an address: under its wildcard, or in its classful network. */
function covers(network: EigrpNetwork, address: Ipv4Address): boolean {
  if (network.wildcard) return matchesWildcard(address, network.address, network.wildcard);
  const major = classfulNetwork(network.address);
  return major !== undefined && inPrefix(major, address);
}

/** The working interfaces a `network` command covers, as EIGRP should run on them now. */
function plan(ctx: DeviceContext, device: Router, config: EigrpConfig): Iface[] {
  return ipInterfaces(device, ctx, undefined)
    .filter((ip) => config.networks.some((network) => covers(network, ip.cidr.address)))
    .map((ip) => ({
      name: ip.name,
      ip,
      passive: config.passiveInterfaces.includes(ip.name),
      link: { bandwidth: bandwidthOf(device, ip), delay: delayOf(device, ip) },
    }));
}

/** Hellos go out of every EIGRP interface but passive ones and loopbacks. */
const saysHello = (iface: Iface) => !iface.passive && iface.ip.medium.kind !== 'loopback';

const hasNeighbors = (process: Process, name: InterfaceId) =>
  [...process.neighbors.values()].some((neighbor) => neighbor.interface === name);

// Sending

function sendPacket(ctx: EigrpContext, iface: Iface, packet: EigrpPacket, to?: Neighbor) {
  sendOn(
    ctx,
    iface.ip,
    {
      kind: 'ipv4',
      src: iface.ip.cidr.address,
      dst: to?.address ?? EIGRP_GROUP,
      ttl: EIGRP_TTL,
      id: ctx.state.nextPacketId++,
      payload: packet,
    },
    to?.mac,
  );
}

/** Sends an update, query or reply, with the next sequence number, to the group or one neighbour. */
function sendReliable(
  ctx: EigrpContext,
  process: Process,
  iface: Iface,
  opcode: EigrpRouting['opcode'],
  routes: readonly EigrpRoute[],
  to?: Neighbor,
  init = false,
) {
  const packet: EigrpRouting = {
    kind: 'eigrp',
    opcode,
    asn: process.asn,
    sequence: ++process.sequence,
    ack: 0,
    init,
    routes,
  };
  sendPacket(ctx, iface, packet, to);
}

function sendHello(ctx: EigrpContext, process: Process, iface: Iface) {
  const { hello, hold } = timersOf(ctx);
  sendPacket(ctx, iface, {
    kind: 'eigrp',
    opcode: 'hello',
    asn: process.asn,
    sequence: 0,
    ack: 0,
    parameters: { kValues: process.kValues, holdTime: hold },
  });
  ctx.setTimer(timerKey({ kind: 'hello', iface: iface.name }), seconds(hello));
}

// Distances

/** The metric of the path through a neighbour: its report with this router's link added. */
function pathMetric(process: Process, key: string, report: Report): EigrpMetric | undefined {
  const neighbor = process.neighbors.get(key);
  const iface = neighbor && process.interfaces.get(neighbor.interface);
  return iface && throughLink(report.metric, iface.link);
}

type Path = { readonly key: string; readonly distance: number; readonly reported: number };

/** Every reachable path to the destination through a neighbour, with both its distances. */
function pathsTo(process: Process, d: Destination): Path[] {
  const paths: Path[] = [];
  for (const [key, report] of d.reports) {
    const metric = pathMetric(process, key, report);
    const distance = metric ? compositeMetric(metric, process.kValues) : INFINITE_METRIC;
    if (distance >= INFINITE_METRIC) continue;
    paths.push({ key, distance, reported: compositeMetric(report.metric, process.kValues) });
  }
  return paths;
}

/**
 * What the destination's best path tells neighbours out of `name`: the origin's metric, or the
 * first successor's. Nothing while it is unreachable, and nothing back out of an interface a
 * successor is on, by split horizon.
 */
function advertised(process: Process, d: Destination, name: InterfaceId): EigrpRoute | undefined {
  if (d.origin) {
    return d.origin.kind === 'redistributed'
      ? { prefix: d.prefix, metric: d.origin.metric, external: d.origin.external }
      : { prefix: d.prefix, metric: d.origin.metric };
  }
  const [first] = d.successors;
  if (first === undefined) return undefined;
  if (d.successors.some((key) => process.neighbors.get(key)?.interface === name)) return undefined;
  const report = d.reports.get(first);
  const metric = report && pathMetric(process, first, report);
  if (!report || !metric || isUnreachable(metric)) return undefined;
  return report.external
    ? { prefix: d.prefix, metric, external: report.external }
    : { prefix: d.prefix, metric };
}

const sameMetric = (m: EigrpMetric, n: EigrpMetric) =>
  m.bandwidth === n.bandwidth &&
  m.delay === n.delay &&
  m.hops === n.hops &&
  m.reliability === n.reliability &&
  m.load === n.load &&
  m.mtu === n.mtu;

function sameRoute(a: EigrpRoute | undefined, b: EigrpRoute | undefined): boolean {
  if (!a || !b) return a === b;
  return sameMetric(a.metric, b.metric) && a.external?.originRouter === b.external?.originRouter;
}

/** The route as withdrawn: what was last said of it, at an infinite metric. */
const withdrawn = (route: EigrpRoute): EigrpRoute => ({
  ...route,
  metric: unreachableMetric(route.metric),
});

/** A destination this router has no way to, as a query or reply says so. */
const unreachableRoute = (prefix: Ipv4Cidr): EigrpRoute => ({
  prefix,
  metric: unreachableMetric(connectedMetric({ bandwidth: 1, delay: 0 })),
});

/** What to tell a neighbour about a destination: its advertisement, or that it is gone. */
const answer = (process: Process, d: Destination, neighbor: Neighbor): EigrpRoute =>
  advertised(process, d, neighbor.interface) ?? unreachableRoute(d.prefix);

// DUAL

function newDestination(ctx: EigrpContext, process: Process, prefix: Ipv4Cidr): Destination {
  const d: Destination = {
    prefix,
    origin: undefined,
    reports: new Map(),
    fd: INFINITE_METRIC,
    successors: [],
    active: undefined,
    told: new Map(),
    since: ctx.now,
  };
  process.destinations.set(keyOf(prefix), d);
  return d;
}

function setSuccessors(ctx: EigrpContext, d: Destination, successors: string[]) {
  const same =
    successors.length === d.successors.length &&
    successors.every((key, i) => key === d.successors[i]);
  if (!same) d.since = ctx.now;
  d.successors = successors;
}

/**
 * Picks the destination's successors while it is passive. Of the paths that meet the feasibility
 * condition, a reported distance below the feasible distance, the best become successors at
 * once and set the feasible distance, as IOS shows it. With no feasible path left, a destination
 * that was reachable goes active, unless there is no neighbour to ask.
 */
function evaluate(ctx: EigrpContext, process: Process, d: Destination, queriedBy?: string) {
  if (d.active) return;
  process.changed.add(keyOf(d.prefix));
  if (d.origin) {
    setSuccessors(ctx, d, []);
    d.fd = compositeMetric(d.origin.metric, process.kValues);
    return;
  }
  const feasible = pathsTo(process, d).filter((path) => path.reported < d.fd);
  if (feasible.length > 0) {
    const best = Math.min(...feasible.map((path) => path.distance));
    const successors = feasible.filter((path) => path.distance === best).slice(0, MAXIMUM_PATHS);
    setSuccessors(
      ctx,
      d,
      successors.map((path) => path.key),
    );
    d.fd = best;
    return;
  }
  if (d.fd < INFINITE_METRIC && process.neighbors.size > 0) {
    goActive(ctx, process, d, queriedBy);
    return;
  }
  setSuccessors(ctx, d, []);
  d.fd = INFINITE_METRIC;
}

/**
 * No feasible successor: queries every neighbour for its distance and waits for all their
 * replies. A successor that is still there, at a worse metric, stays in use meanwhile.
 */
function goActive(ctx: EigrpContext, process: Process, d: Destination, queriedBy?: string) {
  const alive = new Set(pathsTo(process, d).map((path) => path.key));
  setSuccessors(
    ctx,
    d,
    d.successors.filter((key) => alive.has(key)),
  );
  d.active = { awaiting: new Set(process.neighbors.keys()), queriedBy };
  ctx.note(`EIGRP: ${keyOf(d.prefix)} is active, querying ${d.active.awaiting.size} neighbours`);
  for (const iface of process.interfaces.values()) {
    if (!hasNeighbors(process, iface.name)) continue;
    const route = advertised(process, d, iface.name);
    const told = d.told.get(iface.name);
    const query = route ?? (told ? withdrawn(told) : unreachableRoute(d.prefix));
    if (route) d.told.set(iface.name, route);
    else d.told.delete(iface.name);
    let queries = process.queries.get(iface.name);
    if (!queries) process.queries.set(iface.name, (queries = []));
    queries.push(query);
  }
}

/** Every reply is in: the best path left becomes the successor, and the destination is passive. */
function finishActive(ctx: EigrpContext, process: Process, d: Destination) {
  const queriedBy = d.active?.queriedBy;
  d.active = undefined;
  process.changed.add(keyOf(d.prefix));
  const paths = pathsTo(process, d);
  if (paths.length === 0) {
    setSuccessors(ctx, d, []);
    d.fd = INFINITE_METRIC;
  } else {
    const best = Math.min(...paths.map((path) => path.distance));
    const successors = paths.filter((path) => path.distance === best).slice(0, MAXIMUM_PATHS);
    setSuccessors(
      ctx,
      d,
      successors.map((path) => path.key),
    );
    d.fd = best;
  }
  ctx.note(`EIGRP: ${keyOf(d.prefix)} is passive${reachable(d) ? '' : ', unreachable'}`);
  const querier = queriedBy === undefined ? undefined : process.neighbors.get(queriedBy);
  if (querier) queueReply(process, querier, answer(process, d, querier));
}

function queueReply(process: Process, neighbor: Neighbor, route: EigrpRoute) {
  let replies = process.replies.get(neighbor.key);
  if (!replies) process.replies.set(neighbor.key, (replies = []));
  replies.push(route);
}

/** Takes in what a neighbour said of a destination. A withdrawn route is no report. */
function record(d: Destination, neighbor: Neighbor, route: EigrpRoute) {
  if (isUnreachable(route.metric)) d.reports.delete(neighbor.key);
  else d.reports.set(neighbor.key, { metric: route.metric, external: route.external });
}

/** The destination a route names, made new if the route reaches it. */
function destinationFor(
  ctx: EigrpContext,
  process: Process,
  route: EigrpRoute,
): Destination | undefined {
  const prefix = networkOf(route.prefix);
  const known = process.destinations.get(keyOf(prefix));
  if (known || isUnreachable(route.metric)) return known;
  return newDestination(ctx, process, prefix);
}

function onUpdate(ctx: EigrpContext, process: Process, neighbor: Neighbor, route: EigrpRoute) {
  const d = destinationFor(ctx, process, route);
  if (!d) return;
  record(d, neighbor, route);
  evaluate(ctx, process, d);
}

/**
 * A neighbour lost its way and asks for this router's. A passive destination answers at once,
 * unless losing that neighbour's path sends it active too, in which case the reply waits for its
 * own replies. An active one answers that it has no route, so two routers that query each
 * other never wait on each other.
 */
function onQuery(ctx: EigrpContext, process: Process, neighbor: Neighbor, route: EigrpRoute) {
  const d = destinationFor(ctx, process, route);
  if (!d) {
    queueReply(process, neighbor, unreachableRoute(networkOf(route.prefix)));
    return;
  }
  record(d, neighbor, route);
  if (d.active) {
    queueReply(process, neighbor, unreachableRoute(d.prefix));
    return;
  }
  evaluate(ctx, process, d, neighbor.key);
  if (!d.active) queueReply(process, neighbor, answer(process, d, neighbor));
}

function onReply(ctx: EigrpContext, process: Process, neighbor: Neighbor, route: EigrpRoute) {
  const d = destinationFor(ctx, process, route);
  if (!d) return;
  record(d, neighbor, route);
  if (!d.active) {
    evaluate(ctx, process, d);
    return;
  }
  d.active.awaiting.delete(neighbor.key);
  if (d.active.awaiting.size === 0) finishActive(ctx, process, d);
}

/**
 * Sends what the event changed: queries and replies first, then one update out of each interface
 * with neighbours, carrying each destination whose advertisement there changed. A destination
 * that is unreachable is withdrawn where it was told, then forgotten.
 */
function flush(ctx: EigrpContext, process: Process) {
  for (const [name, routes] of process.queries) {
    const iface = process.interfaces.get(name);
    if (iface && hasNeighbors(process, name)) sendReliable(ctx, process, iface, 'query', routes);
  }
  process.queries.clear();
  for (const [key, routes] of process.replies) {
    const neighbor = process.neighbors.get(key);
    const iface = neighbor && process.interfaces.get(neighbor.interface);
    if (neighbor && iface) sendReliable(ctx, process, iface, 'reply', routes, neighbor);
  }
  process.replies.clear();

  const updates = new Map<InterfaceId, EigrpRoute[]>();
  for (const key of [...process.changed].sort()) {
    const d = process.destinations.get(key);
    if (!d || d.active) continue;
    for (const iface of process.interfaces.values()) {
      if (!hasNeighbors(process, iface.name)) continue;
      const route = advertised(process, d, iface.name);
      const told = d.told.get(iface.name);
      if (sameRoute(route, told)) continue;
      let routes = updates.get(iface.name);
      if (!routes) updates.set(iface.name, (routes = []));
      if (route) {
        routes.push(route);
        d.told.set(iface.name, route);
      } else if (told) {
        routes.push(withdrawn(told));
        d.told.delete(iface.name);
      }
    }
    if (!reachable(d) && d.reports.size === 0 && d.told.size === 0) {
      process.destinations.delete(key);
    }
  }
  process.changed.clear();
  for (const [name, routes] of updates) {
    const iface = process.interfaces.get(name);
    if (iface && routes.length > 0) sendReliable(ctx, process, iface, 'update', routes);
  }
}

// Neighbours

const holdKey = (neighbor: Neighbor) => timerKey({ kind: 'hold', neighbor: neighbor.key });

function hold(ctx: EigrpContext, neighbor: Neighbor) {
  neighbor.holdUntil = (ctx.now + seconds(neighbor.holdTime)) as SimTime;
  ctx.setTimer(holdKey(neighbor), seconds(neighbor.holdTime));
}

const nbrChange = (process: Process, neighbor: Neighbor, change: string) =>
  `%DUAL-5-NBRCHANGE: IP-EIGRP ${process.asn}: Neighbor ${neighbor.address} (${neighbor.interface}) is ${change}`;

/** A new neighbour: it gets an INIT update, which asks for its table. */
function addNeighbor(
  ctx: EigrpContext,
  process: Process,
  iface: Iface,
  address: Ipv4Address,
  mac: MacAddress | undefined,
  holdTime: number,
): Neighbor {
  const taken = new Set([...process.neighbors.values()].map((neighbor) => neighbor.handle));
  let handle = 0;
  while (taken.has(handle)) handle++;
  const neighbor: Neighbor = {
    key: neighborKey(iface.name, address),
    address,
    interface: iface.name,
    mac,
    handle,
    holdTime,
    holdUntil: ctx.now,
    upAt: ctx.now,
    sequence: 0,
    initReceived: false,
    lastUpdateAt: undefined,
  };
  process.neighbors.set(neighbor.key, neighbor);
  hold(ctx, neighbor);
  ctx.note(nbrChange(process, neighbor, 'up: new adjacency'));
  sendReliable(ctx, process, iface, 'update', [], neighbor, true);
  return neighbor;
}

/** Forgets everything a neighbour said, as if each of its routes were withdrawn. */
function forgetReports(ctx: EigrpContext, process: Process, neighbor: Neighbor) {
  for (const d of process.destinations.values()) {
    const had = d.reports.delete(neighbor.key);
    if (d.active) {
      if (d.active.awaiting.delete(neighbor.key) && d.active.awaiting.size === 0) {
        finishActive(ctx, process, d);
      }
    } else if (had) {
      evaluate(ctx, process, d);
    }
  }
}

function dropNeighbor(ctx: EigrpContext, process: Process, neighbor: Neighbor, reason: string) {
  process.neighbors.delete(neighbor.key);
  ctx.clearTimer(holdKey(neighbor));
  ctx.note(nbrChange(process, neighbor, `down: ${reason}`));
  forgetReports(ctx, process, neighbor);
  if (!hasNeighbors(process, neighbor.interface)) {
    for (const d of process.destinations.values()) d.told.delete(neighbor.interface);
  }
}

/** The neighbour asked for this router's table with its INIT update: every route it may hear. */
function sendTable(ctx: EigrpContext, process: Process, neighbor: Neighbor) {
  const iface = process.interfaces.get(neighbor.interface);
  if (!iface) return;
  const routes: EigrpRoute[] = [];
  const keys = [...process.destinations.keys()].sort();
  for (const key of keys) {
    const d = process.destinations.get(key)!;
    const route = d.active ? undefined : advertised(process, d, iface.name);
    if (!route) continue;
    routes.push(route);
    d.told.set(iface.name, route);
  }
  if (routes.length > 0) sendReliable(ctx, process, iface, 'update', routes, neighbor);
}

function onPacket(
  ctx: EigrpContext,
  process: Process,
  iface: Iface,
  src: Ipv4Address,
  packet: EigrpPacket,
  mac: MacAddress | undefined,
) {
  if (packet.asn !== process.asn || iface.passive) return;
  // Only a neighbour on the interface's own subnet, never this router's own packets.
  if (!inPrefix(iface.ip.cidr, src) || src === iface.ip.cidr.address) return;
  let neighbor = process.neighbors.get(neighborKey(iface.name, src));

  if (packet.opcode === 'hello') {
    const { parameters } = packet;
    if (!parameters) return;
    if (!sameK(parameters.kValues, process.kValues)) {
      if (neighbor) dropNeighbor(ctx, process, neighbor, 'K-value mismatch');
      else ctx.note(`EIGRP: hello from ${src} on ${iface.name} has other K-values`);
      flush(ctx, process);
      return;
    }
    neighbor ??= addNeighbor(ctx, process, iface, src, mac, parameters.holdTime);
    neighbor.mac = mac ?? neighbor.mac;
    neighbor.holdTime = parameters.holdTime;
    hold(ctx, neighbor);
    flush(ctx, process);
    return;
  }

  if (!neighbor) {
    if (packet.opcode !== 'update' || !packet.init) return;
    neighbor = addNeighbor(ctx, process, iface, src, mac, timersOf(ctx).hold);
  }
  neighbor.mac = mac ?? neighbor.mac;
  hold(ctx, neighbor);
  if (packet.sequence > 0) {
    neighbor.sequence = packet.sequence;
    sendPacket(
      ctx,
      iface,
      { kind: 'eigrp', opcode: 'hello', asn: process.asn, sequence: 0, ack: packet.sequence },
      neighbor,
    );
  }
  if (packet.routes.length > 0) neighbor.lastUpdateAt = ctx.now;

  if (packet.opcode === 'update' && packet.init) {
    if (neighbor.initReceived) {
      // It restarted: what it said before no longer holds, and it needs this router's table again.
      ctx.note(nbrChange(process, neighbor, 'down: peer restarted'));
      forgetReports(ctx, process, neighbor);
      sendReliable(ctx, process, iface, 'update', [], neighbor, true);
    }
    neighbor.initReceived = true;
    flush(ctx, process);
    sendTable(ctx, process, neighbor);
    return;
  }
  for (const route of packet.routes) {
    if (packet.opcode === 'update') onUpdate(ctx, process, neighbor, route);
    else if (packet.opcode === 'query') onQuery(ctx, process, neighbor, route);
    else onReply(ctx, process, neighbor, route);
  }
  flush(ctx, process);
}

// The process

/** Stops EIGRP: its neighbours, timers and tables go. */
function stop(ctx: EigrpContext) {
  const { process } = ctx.state;
  if (!process) return;
  for (const neighbor of process.neighbors.values()) ctx.clearTimer(holdKey(neighbor));
  for (const name of process.interfaces.keys()) {
    ctx.clearTimer(timerKey({ kind: 'hello', iface: name }));
  }
  ctx.state.process = undefined;
}

/**
 * Brings the interfaces in line with the config and the links. Neighbours on an interface EIGRP
 * leaves, or that goes passive or changes address, are dropped. A new interface says hello at
 * once. Link metrics follow `bandwidth` and `delay`.
 */
function syncInterfaces(ctx: EigrpContext, process: Process, device: Router, config: EigrpConfig) {
  const planned = new Map(plan(ctx, device, config).map((iface) => [iface.name, iface]));
  for (const iface of process.interfaces.values()) {
    const next = planned.get(iface.name);
    const moved =
      next &&
      (next.ip.cidr.address !== iface.ip.cidr.address ||
        next.ip.cidr.prefixLength !== iface.ip.cidr.prefixLength);
    const reason = !next
      ? 'interface down'
      : moved
        ? 'address changed'
        : next.passive && !iface.passive
          ? 'interface passive'
          : undefined;
    if (reason) {
      for (const neighbor of [...process.neighbors.values()]) {
        if (neighbor.interface === iface.name) dropNeighbor(ctx, process, neighbor, reason);
      }
    }
    if (!next) {
      process.interfaces.delete(iface.name);
      ctx.clearTimer(timerKey({ kind: 'hello', iface: iface.name }));
    }
  }
  for (const next of planned.values()) {
    const current = process.interfaces.get(next.name);
    const wasSaying = current ? saysHello(current) : false;
    if (current) {
      current.ip = next.ip;
      current.passive = next.passive;
      current.link = next.link;
    } else {
      process.interfaces.set(next.name, next);
    }
    const iface = current ?? next;
    if (saysHello(iface) && !wasSaying) sendHello(ctx, process, iface);
    if (!saysHello(iface)) ctx.clearTimer(timerKey({ kind: 'hello', iface: iface.name }));
  }
}

/**
 * The static routes `redistribute static` brings in: each whose way out is a working interface,
 * directly or through a next hop on a connected subnet, and that beats EIGRP's own distance. It
 * takes the redistribution's metric, else that of the interface it leaves by.
 */
function redistributed(
  ctx: DeviceContext,
  process: Process,
  device: Router,
  config: EigrpConfig,
): Map<string, { prefix: Ipv4Cidr; origin: Origin }> {
  const found = new Map<string, { prefix: Ipv4Cidr; origin: Origin }>();
  const redistribution = config.redistributeStatic;
  if (!redistribution) return found;
  const interfaces = ipInterfaces(device, ctx, undefined);
  for (const route of device.config.staticRoutes) {
    if ((route.distance ?? ADMINISTRATIVE_DISTANCE.static) >= ADMINISTRATIVE_DISTANCE.eigrp) {
      continue;
    }
    const hop = route.nextHop;
    const exit = interfaces.find((iface) =>
      hop.kind === 'interface' ? iface.name === hop.interface : inPrefix(iface.cidr, hop.address),
    );
    if (!exit) continue;
    const metric = redistribution.metric
      ? { ...redistribution.metric, hops: 0 }
      : connectedMetric({ bandwidth: bandwidthOf(device, exit), delay: delayOf(device, exit) });
    const prefix = networkOf(route.prefix);
    const external: EigrpExternal = {
      originRouter: process.routerId,
      originAs: process.asn,
      protocol: 'static',
      externalMetric: 0,
    };
    if (!found.has(keyOf(prefix))) {
      found.set(keyOf(prefix), { prefix, origin: { kind: 'redistributed', metric, external } });
    }
  }
  return found;
}

function sameOrigin(a: Origin | undefined, b: Origin): boolean {
  if (!a || !sameMetric(a.metric, b.metric)) return false;
  if (a.kind === 'connected') return b.kind === 'connected' && a.interface === b.interface;
  return b.kind === 'redistributed';
}

/**
 * The destinations this router originates: the network of each EIGRP interface, passive ones and
 * loopbacks included, and each redistributed static route. One it no longer originates falls
 * back on its neighbours' paths, which may send it active.
 */
function syncOrigins(ctx: EigrpContext, process: Process, device: Router, config: EigrpConfig) {
  const origins = new Map<string, { prefix: Ipv4Cidr; origin: Origin }>();
  for (const iface of process.interfaces.values()) {
    const prefix = networkOf(iface.ip.cidr);
    if (origins.has(keyOf(prefix))) continue;
    const metric = connectedMetric(iface.link);
    origins.set(keyOf(prefix), {
      prefix,
      origin: { kind: 'connected', interface: iface.name, metric },
    });
  }
  for (const [key, entry] of redistributed(ctx, process, device, config)) {
    if (!origins.has(key)) origins.set(key, entry);
  }
  for (const [key, d] of process.destinations) {
    if (d.origin && !origins.has(key)) {
      d.origin = undefined;
      evaluate(ctx, process, d);
    }
  }
  for (const [key, { prefix, origin }] of origins) {
    const d = process.destinations.get(key) ?? newDestination(ctx, process, prefix);
    if (!sameOrigin(d.origin, origin)) d.origin = origin;
  }
}

/**
 * Brings the process in line with the config, the links and the lab's timers. A new AS, router
 * ID, K-values or timer profile restarts it. Then every passive destination is weighed again,
 * since a link's metric may have changed.
 */
function reconcile(ctx: EigrpContext) {
  const { device } = ctx;
  const config = eigrpConfig(device);
  if (!config || device.kind !== 'router') {
    stop(ctx);
    return;
  }
  const kValues = config.kValues ?? DEFAULT_K_VALUES;
  const profile = ctx.settings.routingTimers;
  let { process } = ctx.state;
  if (
    process &&
    (process.asn !== config.asn ||
      process.configuredId !== config.routerId ||
      process.profile !== profile ||
      !sameK(process.kValues, kValues))
  ) {
    stop(ctx);
    process = undefined;
  }
  if (!process) {
    const routerId = pickRouterId(ctx, config.routerId);
    if (!routerId) return;
    process = {
      asn: config.asn,
      routerId,
      configuredId: config.routerId,
      profile,
      kValues,
      interfaces: new Map(),
      neighbors: new Map(),
      destinations: new Map(),
      changed: new Set(),
      queries: new Map(),
      replies: new Map(),
      sequence: 0,
    };
    ctx.state.process = process;
  }
  syncInterfaces(ctx, process, device, config);
  syncOrigins(ctx, process, device, config);
  for (const d of process.destinations.values()) evaluate(ctx, process, d);
  flush(ctx, process);
}

function onTimer(ctx: EigrpContext, key: string) {
  const timer = parseTimer(key);
  if (!timer) return;
  if (timer.kind === 'start') {
    reconcile(ctx);
    return;
  }
  const { process } = ctx.state;
  if (!process) return;
  switch (timer.kind) {
    case 'hello': {
      const iface = process.interfaces.get(timer.iface);
      if (iface && saysHello(iface)) sendHello(ctx, process, iface);
      return;
    }
    case 'hold': {
      const neighbor = process.neighbors.get(timer.neighbor);
      if (!neighbor) return;
      dropNeighbor(ctx, process, neighbor, 'holding time expired');
      flush(ctx, process);
      return;
    }
  }
}

// Queries

function topologyEntry(process: Process, d: Destination): EigrpTopologyEntry {
  const paths: EigrpPathStatus[] = [];
  if (d.origin?.kind === 'connected') {
    paths.push({ kind: 'connected', interface: d.origin.interface });
  } else if (d.origin) {
    paths.push({ kind: 'redistributed', distance: d.fd });
  }
  const neighborPaths = pathsTo(process, d)
    .map((path) => ({ ...path, successor: !d.origin && d.successors.includes(path.key) }))
    .sort((a, b) => Number(b.successor) - Number(a.successor) || a.distance - b.distance);
  for (const path of neighborPaths) {
    const neighbor = process.neighbors.get(path.key)!;
    paths.push({
      kind: 'neighbor',
      via: neighbor.address,
      interface: neighbor.interface,
      distance: path.distance,
      reported: path.reported,
      successor: path.successor,
      feasible: path.reported < d.fd,
    });
  }
  const [first] = d.successors;
  return {
    prefix: d.prefix,
    state: d.active ? 'active' : 'passive',
    successors: d.origin ? 1 : d.successors.length,
    feasibleDistance: d.fd,
    external:
      d.origin?.kind === 'redistributed' ||
      (!d.origin && first !== undefined && d.reports.get(first)?.external !== undefined),
    paths,
  };
}

/** The EIGRP process's status, or undefined when the router has no `router eigrp`. */
export function eigrpStatus(ctx: EigrpContext): EigrpStatus | undefined {
  const config = eigrpConfig(ctx.device);
  if (!config) return undefined;
  const timers = timersOf(ctx);
  const kValues = config.kValues ?? DEFAULT_K_VALUES;
  const { process } = ctx.state;
  if (!process) {
    return {
      asn: config.asn,
      routerId: undefined,
      kValues,
      timers,
      interfaces: [],
      neighbors: [],
      topology: [],
      sources: [],
    };
  }
  const order = ipInterfaces(ctx.device, ctx, undefined).map((ip) => ip.name);
  const neighbors = [...process.neighbors.values()];
  const destinations = [...process.destinations.values()]
    .filter((d) => reachable(d) || d.active)
    .sort(
      (a, b) =>
        compareAddresses(a.prefix.address, b.prefix.address) ||
        a.prefix.prefixLength - b.prefix.prefixLength,
    );
  return {
    asn: process.asn,
    routerId: process.routerId,
    kValues: process.kValues,
    timers,
    interfaces: [...process.interfaces.values()]
      .filter((iface) => !iface.passive)
      .sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name))
      .map((iface) => ({
        name: iface.name,
        peers: neighbors.filter((neighbor) => neighbor.interface === iface.name).length,
      })),
    neighbors: neighbors
      .sort((a, b) => a.handle - b.handle)
      .map((neighbor) => ({
        handle: neighbor.handle,
        address: neighbor.address,
        interface: neighbor.interface,
        holdMs: Math.max(0, neighbor.holdUntil - ctx.now),
        uptimeMs: ctx.now - neighbor.upAt,
        sequence: neighbor.sequence,
      })),
    topology: destinations.map((d) => topologyEntry(process, d)),
    sources: neighbors
      .filter((neighbor) => neighbor.lastUpdateAt !== undefined)
      .sort((a, b) => compareAddresses(a.address, b.address))
      .map((neighbor) => ({ gateway: neighbor.address, lastUpdateAt: neighbor.lastUpdateAt! })),
  };
}

/** EIGRP's distance for a route: 90 for one learned inside EIGRP, 170 for an external one. */
export const EIGRP_EXTERNAL_DISTANCE = 170;

/** EIGRP on a router. The engine starts it on every router; it idles until `router eigrp`. */
export const eigrpModule: SimModule<EigrpState> = {
  id: 'eigrp',
  init(ctx) {
    ctx.setTimer(timerKey({ kind: 'start' }), ms(0));
    return { process: undefined, nextPacketId: 1 };
  },
  onFrame(ctx, port, frame) {
    const { process } = ctx.state;
    if (!process || packetIn(frame)?.payload.kind !== 'eigrp') return;
    const interfaces = [...process.interfaces.values()].map((iface) => iface.ip);
    const arrived = arrival(ctx, interfaces, port, frame, [EIGRP_GROUP]);
    const iface = arrived && process.interfaces.get(arrived.iface.name);
    if (!arrived || !iface || arrived.packet.payload.kind !== 'eigrp') return;
    onPacket(ctx, process, iface, arrived.packet.src, arrived.packet.payload, arrived.mac);
  },
  onTimer,
  onLinkChange: reconcile,
  onConfigChange: reconcile,
  routes(ctx): LearnedRoute[] {
    const { process } = ctx.state;
    const config = eigrpConfig(ctx.device);
    if (!process || !config) return [];
    const learned: LearnedRoute[] = [];
    for (const d of process.destinations.values()) {
      if (d.origin || d.successors.length === 0) continue;
      const paths = pathsTo(process, d);
      const successors = paths.filter((path) => d.successors.includes(path.key));
      const best = Math.min(...successors.map((path) => path.distance));
      // With `variance`, feasible successors within that many times the best share the load.
      const sharing = paths
        .filter(
          (path) =>
            !d.successors.includes(path.key) &&
            path.reported < d.fd &&
            path.distance < config.variance * best,
        )
        .sort((a, b) => a.distance - b.distance);
      const external = d.reports.get(d.successors[0]!)?.external !== undefined;
      for (const path of [...successors, ...sharing].slice(0, MAXIMUM_PATHS)) {
        const neighbor = process.neighbors.get(path.key)!;
        learned.push({
          source: 'eigrp',
          prefix: d.prefix,
          distance: external ? EIGRP_EXTERNAL_DISTANCE : ADMINISTRATIVE_DISTANCE.eigrp,
          metric: path.distance,
          ...(path.distance !== best && { rank: best }),
          ...(external && { external: true as const }),
          via: neighbor.address,
          interface: neighbor.interface,
          ageMs: ctx.now - d.since,
        });
      }
    }
    return learned;
  },
};
