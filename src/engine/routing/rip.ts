import type { Device, InterfaceId, Ipv4Address, Ipv4Cidr, PrefixLength, RipConfig } from '@/model';
import { ms, type SimDuration, type SimTime } from '../core/time';
import { ipInterfaces, ownsAddress, routingDevice, type IpInterface } from '../l3/interfaces';
import { classfulLength, classfulNetwork, compareAddresses, inPrefix, networkOf } from '../l3/ipv4';
import { ADMINISTRATIVE_DISTANCE, type LearnedRoute } from '../l3/routes';
import type { DeviceContext, ModuleContext, SimModule } from '../module';
import {
  LIMITED_BROADCAST,
  RIP_GROUP,
  RIP_INFINITY,
  RIP_MAX_ENTRIES,
  UDP_PORT,
  type Ipv4Packet,
  type RipEntry,
  type RipMessage,
  type RipVersion,
} from '../pdu';
import { arrival, packetIn, sendOn, type Arrival } from './link';
import { RIP_TIMERS, type RipTimers } from './timers';

/**
 * RIP as IOS runs it, version 1 or 2, by RFC 2453 with Cisco's holddown. Each router tells its
 * neighbours every network it knows and how many hops away it is. A route nobody refreshes goes
 * invalid, is held down, then flushed. News travels further by triggered updates the moment a
 * route changes, split horizon keeps a router from telling a neighbour what it learned from it,
 * and a route that fails is poisoned: advertised at 16 hops, unreachable, until it is flushed.
 */

/** What `show ip protocols` reads of a router's RIP process as it runs. */
export type RipStatus = {
  /** The timers in use, from the lab's routing timer profile. */
  readonly timers: RipTimers;
  /** Until the next periodic update goes out. */
  readonly nextUpdateMs: number;
  /** The interfaces RIP sends updates out of and listens on, in interface order. Not passive ones. */
  readonly interfaces: readonly InterfaceId[];
  /** Each neighbour RIP has heard an update from, by address, and how long ago. */
  readonly sources: readonly { readonly gateway: Ipv4Address; readonly lastUpdateMs: number }[];
};

type Source = { readonly address: Ipv4Address; readonly interface: InterfaceId };

/** One network in the RIP database. */
type RipRoute = {
  readonly prefix: Ipv4Cidr;
  /** Hops away: 0 for a network of this router's own, 1 to 15 learned, RIP_INFINITY when down. */
  metric: number;
  /** The neighbour it came from. None for this router's own: a connected or originated network. */
  from: Source | undefined;
  updatedAt: SimTime;
  /** While held down: the metric before it went down, and until when worse news is ignored. */
  held: { readonly metric: number; readonly until: SimTime } | undefined;
};

export type RipState = {
  /** The database, by network as `10.1.0.0/16`. */
  readonly routes: Map<string, RipRoute>;
  /** Networks changed since an update last went out, for the next triggered update. */
  readonly changed: Set<string>;
  /** When each neighbour's last update arrived. */
  readonly sources: Map<Ipv4Address, SimTime>;
  /** The interfaces updates went out of after the last change, so a new one asks for tables. */
  sending: InterfaceId[];
  nextUpdateAt: SimTime | undefined;
  nextPacketId: number;
};

type RipContext = ModuleContext<RipState>;

type Timer =
  | { readonly kind: 'start' | 'update' | 'triggered' }
  | { readonly kind: 'invalid' | 'flush'; readonly network: string };

const timerKey = (timer: Timer) =>
  'network' in timer ? `rip ${timer.kind} ${timer.network}` : `rip ${timer.kind}`;

function parseTimer(key: string): Timer | undefined {
  const [prefix, kind, network = ''] = key.split(' ');
  if (prefix !== 'rip') return undefined;
  switch (kind) {
    case 'start':
    case 'update':
    case 'triggered':
      return { kind };
    case 'invalid':
    case 'flush':
      return { kind, network };
    default:
      return undefined;
  }
}

const DEFAULT_ROUTE: Ipv4Cidr = {
  address: '0.0.0.0' as Ipv4Address,
  prefixLength: 0 as PrefixLength,
};

/** RIP packets live two hops, as IOS sends them: they never need to leave the link. */
const RIP_TTL = 2;

const seconds = (value: number): SimDuration => ms(value * 1000);
const keyOf = ({ address, prefixLength }: Ipv4Cidr) => `${address}/${prefixLength}`;
const timersOf = (ctx: DeviceContext) => RIP_TIMERS[ctx.settings.routingTimers];

const ripConfig = (device: Device): RipConfig | undefined => routingDevice(device)?.config.rip;

/** IOS sends RIPv1 until told `version 2`. */
const sendVersion = (config: RipConfig): RipVersion => config.version ?? 1;

/** Without `version`, IOS takes both versions in. */
const receives = (config: RipConfig, version: RipVersion) =>
  config.version === undefined || config.version === version;

/** Whether two prefixes sit in the same classful network. */
const sameMajor = (a: Ipv4Address, b: Ipv4Address) => {
  const major = classfulNetwork(a);
  return major !== undefined && inPrefix(major, b);
};

/**
 * The working interfaces RIP runs on: those whose classful network a `network` command names.
 * A loopback's network is advertised, but nothing is sent out of it.
 */
function ripInterfaces(ctx: DeviceContext, config: RipConfig): IpInterface[] {
  return ipInterfaces(ctx.device, ctx, undefined).filter((iface) => {
    const major = classfulNetwork(iface.cidr.address);
    return major !== undefined && config.networks.includes(major.address);
  });
}

/** The RIP interfaces updates go out of: not loopbacks, not passive. */
const sendsOn = (config: RipConfig, iface: IpInterface) =>
  iface.medium.kind !== 'loopback' && !config.passiveInterfaces.includes(iface.name);

function packet(
  ctx: RipContext,
  iface: IpInterface,
  dst: Ipv4Address,
  message: RipMessage,
): Ipv4Packet {
  return {
    kind: 'ipv4',
    src: iface.cidr.address,
    dst,
    ttl: RIP_TTL,
    id: ctx.state.nextPacketId++,
    payload: { kind: 'udp', srcPort: UDP_PORT.rip, dstPort: UDP_PORT.rip, payload: message },
  };
}

/** Where a version's updates go: RIPv2's multicast group, or RIPv1's broadcast. */
const updateDestination = (version: RipVersion) => (version === 2 ? RIP_GROUP : LIMITED_BROADCAST);

/**
 * The routes to advertise out of `iface`, by split horizon: not those learned through it, nor the
 * interface's own network, which its neighbours have too. With auto-summary, and always in RIPv1,
 * subnets of another classful network go out as that network at their best metric. RIPv1 carries
 * no mask, so it sends only the subnets of the interface's own network with the interface's mask.
 */
function advertisement(
  config: RipConfig,
  routes: Iterable<RipRoute>,
  iface: IpInterface,
): RipEntry[] {
  const version = sendVersion(config);
  const summarize = version === 1 || config.autoSummary;
  const own = keyOf(networkOf(iface.cidr));
  const best = new Map<string, { prefix: Ipv4Cidr; metric: number }>();
  for (const route of routes) {
    if (route.from?.interface === iface.name || keyOf(route.prefix) === own) continue;
    let { prefix } = route;
    const classful = classfulLength(prefix.address) ?? 32;
    const local = sameMajor(iface.cidr.address, prefix.address);
    const isDefault = prefix.prefixLength === 0;
    if (summarize && !local && !isDefault && prefix.prefixLength > classful) {
      prefix = classfulNetwork(prefix.address)!;
    }
    if (version === 1 && !isDefault) {
      const fits = local
        ? prefix.prefixLength === iface.cidr.prefixLength
        : prefix.prefixLength === classful;
      if (!fits) continue;
    }
    const metric = Math.min(route.metric + 1, RIP_INFINITY);
    const held = best.get(keyOf(prefix));
    if (!held || metric < held.metric) best.set(keyOf(prefix), { prefix, metric });
  }
  return [...best.values()]
    .sort(
      (a, b) =>
        compareAddresses(a.prefix.address, b.prefix.address) ||
        a.prefix.prefixLength - b.prefix.prefixLength,
    )
    .map(({ prefix, metric }) =>
      version === 2
        ? { network: prefix.address, prefixLength: prefix.prefixLength, metric }
        : { network: prefix.address, metric },
    );
}

/** Sends routes as responses, RIP_MAX_ENTRIES to a message, to `dst` or the update address. */
function respond(
  ctx: RipContext,
  config: RipConfig,
  iface: IpInterface,
  entries: readonly RipEntry[],
  to?: Pick<Arrival, 'mac'> & { address: Ipv4Address },
) {
  const version = sendVersion(config);
  const dst = to?.address ?? updateDestination(version);
  for (let start = 0; start < entries.length; start += RIP_MAX_ENTRIES) {
    const message: RipMessage = {
      kind: 'rip',
      command: 'response',
      version,
      entries: entries.slice(start, start + RIP_MAX_ENTRIES),
    };
    sendOn(ctx, iface, packet(ctx, iface, dst, message), to?.mac);
  }
}

/** Sends a full update out of every interface RIP sends on, and starts the next period. */
function sendUpdate(ctx: RipContext, config: RipConfig) {
  const routes = [...ctx.state.routes.values()];
  for (const iface of ripInterfaces(ctx, config)) {
    if (sendsOn(config, iface)) respond(ctx, config, iface, advertisement(config, routes, iface));
  }
  ctx.state.changed.clear();
  ctx.clearTimer(timerKey({ kind: 'triggered' }));
  const period = seconds(timersOf(ctx).update);
  ctx.state.nextUpdateAt = (ctx.now + period) as SimTime;
  ctx.setTimer(timerKey({ kind: 'update' }), period);
}

/** Sends only what changed since the last update, out of every interface RIP sends on. */
function sendTriggered(ctx: RipContext, config: RipConfig) {
  const { routes, changed } = ctx.state;
  const news = [...changed].flatMap((key) => {
    const route = routes.get(key);
    return route ? [route] : [];
  });
  changed.clear();
  if (news.length === 0) return;
  for (const iface of ripInterfaces(ctx, config)) {
    if (sendsOn(config, iface)) respond(ctx, config, iface, advertisement(config, news, iface));
  }
}

function markChanged(ctx: RipContext, key: string) {
  ctx.state.changed.add(key);
  ctx.setTimer(timerKey({ kind: 'triggered' }), ms(0));
}

/** Installs or replaces a route learned from `from`, with a fresh invalid timer. */
function install(
  ctx: RipContext,
  prefix: Ipv4Cidr,
  metric: number,
  from: Source | undefined,
): void {
  const key = keyOf(prefix);
  const before = ctx.state.routes.get(key);
  ctx.state.routes.set(key, { prefix, metric, from, updatedAt: ctx.now, held: undefined });
  ctx.clearTimer(timerKey({ kind: 'flush', network: key }));
  if (from)
    ctx.setTimer(timerKey({ kind: 'invalid', network: key }), seconds(timersOf(ctx).invalid));
  else ctx.clearTimer(timerKey({ kind: 'invalid', network: key }));
  const same =
    before?.metric === metric &&
    before.from?.address === from?.address &&
    before.from?.interface === from?.interface;
  if (same) return;
  markChanged(ctx, key);
  if (from) ctx.note(`RIP: ${key} via ${from.address}, ${metric} hop${metric === 1 ? '' : 's'}`);
}

/**
 * The route is unreachable: it is poisoned, advertised at RIP_INFINITY until it is flushed. One
 * that timed out or was poisoned by its own source is held down too, so worse news of it from
 * other neighbours, which may still be the stale route coming back, is ignored for a while.
 */
function goDown(ctx: RipContext, key: string, route: RipRoute, hold: boolean) {
  const { holddown, invalid, flush } = timersOf(ctx);
  route.held =
    hold && route.from
      ? { metric: route.metric, until: (ctx.now + seconds(holddown)) as SimTime }
      : undefined;
  route.metric = RIP_INFINITY;
  ctx.clearTimer(timerKey({ kind: 'invalid', network: key }));
  ctx.setTimer(timerKey({ kind: 'flush', network: key }), seconds(flush - invalid));
  markChanged(ctx, key);
  ctx.note(`RIP: ${key} is unreachable${route.held ? ', held down' : ''}`);
}

/**
 * The prefix of a RIPv1 entry, which carries no mask: a subnet of the receiving interface's own
 * classful network has the interface's mask, any other network its classful mask.
 */
function v1Prefix(iface: IpInterface, network: Ipv4Address): Ipv4Cidr | undefined {
  if (network === DEFAULT_ROUTE.address) return DEFAULT_ROUTE;
  if (sameMajor(iface.cidr.address, network)) {
    return { address: network, prefixLength: iface.cidr.prefixLength };
  }
  const prefixLength = classfulLength(network);
  return prefixLength === undefined ? undefined : { address: network, prefixLength };
}

/** One route from a neighbour's response, weighed against what the database holds. */
function learn(ctx: RipContext, iface: IpInterface, sender: Ipv4Address, entry: RipEntry) {
  if (entry.metric < 1 || entry.metric > RIP_INFINITY) return;
  const prefix =
    entry.prefixLength === undefined
      ? v1Prefix(iface, entry.network)
      : { address: entry.network, prefixLength: entry.prefixLength };
  // A network with host bits set, or a class D or E one, is no route.
  if (!prefix || networkOf(prefix).address !== prefix.address) return;
  if (prefix.prefixLength > 0 && classfulLength(prefix.address) === undefined) return;

  const key = keyOf(prefix);
  // The sender counted its own hop, as IOS does: a route one router away arrives as 1.
  const { metric } = entry;
  const from: Source = { address: sender, interface: iface.name };
  const route = ctx.state.routes.get(key);
  if (!route) {
    if (metric < RIP_INFINITY) install(ctx, prefix, metric, from);
    return;
  }
  if (!route.from) {
    // One of this router's own networks, unless it is down and being flushed.
    if (route.metric === RIP_INFINITY && metric < RIP_INFINITY) install(ctx, prefix, metric, from);
    return;
  }
  if (route.from.address === sender) {
    if (metric < RIP_INFINITY) install(ctx, prefix, metric, from);
    else if (route.metric < RIP_INFINITY) goDown(ctx, key, route, true);
    return;
  }
  const held = route.held && ctx.now < route.held.until ? route.held.metric : undefined;
  if (metric < (held ?? route.metric)) install(ctx, prefix, metric, from);
}

function onMessage(ctx: RipContext, config: RipConfig, { iface, packet, mac }: Arrival) {
  const datagram = packet.payload;
  if (datagram.kind !== 'udp' || datagram.dstPort !== UDP_PORT.rip) return;
  const message = datagram.payload;
  if (message.kind !== 'rip' || !receives(config, message.version)) return;
  // Only a neighbour on the interface's own subnet, never this router's own packets.
  const interfaces = ripInterfaces(ctx, config);
  if (!interfaces.some((candidate) => candidate.name === iface.name)) return;
  if (!inPrefix(iface.cidr, packet.src) || ownsAddress(interfaces, packet.src)) return;

  if (message.command === 'request') {
    if (!sendsOn(config, iface)) return;
    const entries = advertisement(config, ctx.state.routes.values(), iface);
    respond(ctx, config, iface, entries, { address: packet.src, mac });
    return;
  }
  ctx.state.sources.set(packet.src, ctx.now);
  for (const entry of message.entries) learn(ctx, iface, packet.src, entry);
}

/** Stops RIP: the database, its timers and the update schedule go. */
function stop(ctx: RipContext) {
  const { state } = ctx;
  for (const key of state.routes.keys()) {
    ctx.clearTimer(timerKey({ kind: 'invalid', network: key }));
    ctx.clearTimer(timerKey({ kind: 'flush', network: key }));
  }
  ctx.clearTimer(timerKey({ kind: 'update' }));
  ctx.clearTimer(timerKey({ kind: 'triggered' }));
  state.routes.clear();
  state.changed.clear();
  state.sources.clear();
  state.sending = [];
  state.nextUpdateAt = undefined;
}

/**
 * Brings the database in line with the config and the links: the router's own networks are
 * those of its RIP interfaces, plus a default route with `default-information originate`. A
 * network it no longer has, and every route through an interface RIP no longer runs on, is
 * poisoned at once. An interface RIP starts sending on asks its neighbours for their tables.
 */
function reconcile(ctx: RipContext) {
  const config = ripConfig(ctx.device);
  if (!config) {
    stop(ctx);
    return;
  }
  const { state } = ctx;
  const interfaces = ripInterfaces(ctx, config);
  const own = new Map(
    interfaces.map((iface) => [keyOf(networkOf(iface.cidr)), networkOf(iface.cidr)]),
  );
  if (config.defaultOriginate) own.set(keyOf(DEFAULT_ROUTE), DEFAULT_ROUTE);
  const running = new Set(interfaces.map((iface) => iface.name));

  for (const [key, route] of state.routes) {
    if (route.metric === RIP_INFINITY) continue;
    const gone = route.from ? !running.has(route.from.interface) : !own.has(key);
    if (gone) goDown(ctx, key, route, false);
  }
  for (const prefix of own.values()) {
    const route = state.routes.get(keyOf(prefix));
    if (route?.from !== undefined || route?.metric !== 0) install(ctx, prefix, 0, undefined);
  }

  const sending = interfaces.filter((iface) => sendsOn(config, iface));
  const version = sendVersion(config);
  for (const iface of sending) {
    if (state.sending.includes(iface.name)) continue;
    const request: RipMessage = { kind: 'rip', command: 'request', version };
    sendOn(ctx, iface, packet(ctx, iface, updateDestination(version), request));
  }
  state.sending = sending.map((iface) => iface.name);
  if (sending.length > 0 && state.nextUpdateAt === undefined) {
    const period = seconds(timersOf(ctx).update);
    state.nextUpdateAt = (ctx.now + period) as SimTime;
    ctx.setTimer(timerKey({ kind: 'update' }), period);
  }
}

function onTimer(ctx: RipContext, timer: Timer) {
  const config = ripConfig(ctx.device);
  if (timer.kind === 'start') {
    reconcile(ctx);
    return;
  }
  if (!config) return;
  switch (timer.kind) {
    case 'update':
      sendUpdate(ctx, config);
      return;
    case 'triggered':
      sendTriggered(ctx, config);
      return;
    case 'invalid': {
      const route = ctx.state.routes.get(timer.network);
      if (route?.from && route.metric < RIP_INFINITY) goDown(ctx, timer.network, route, true);
      return;
    }
    case 'flush': {
      const route = ctx.state.routes.get(timer.network);
      if (route?.metric !== RIP_INFINITY) return;
      ctx.state.routes.delete(timer.network);
      ctx.state.changed.delete(timer.network);
      ctx.note(`RIP: ${timer.network} flushed`);
      return;
    }
  }
}

/** The RIP process's status, or undefined when the router has no `router rip`. */
export function ripStatus(ctx: RipContext): RipStatus | undefined {
  const config = ripConfig(ctx.device);
  if (!config) return undefined;
  const timers = timersOf(ctx);
  const { nextUpdateAt, sources } = ctx.state;
  const heard = [...sources]
    .filter(([, at]) => ctx.now - at < seconds(timers.flush))
    .sort(([a], [b]) => compareAddresses(a, b))
    .map(([gateway, at]) => ({ gateway, lastUpdateMs: ctx.now - at }));
  return {
    timers,
    nextUpdateMs: nextUpdateAt === undefined ? 0 : Math.max(0, nextUpdateAt - ctx.now),
    interfaces: ripInterfaces(ctx, config)
      .filter((iface) => !config.passiveInterfaces.includes(iface.name))
      .map((iface) => iface.name),
    sources: heard,
  };
}

/** RIP on a router. The engine starts it on every router; it idles until `router rip`. */
export const ripModule: SimModule<RipState> = {
  id: 'rip',
  init(ctx) {
    ctx.setTimer(timerKey({ kind: 'start' }), ms(0));
    return {
      routes: new Map(),
      changed: new Set(),
      sources: new Map(),
      sending: [],
      nextUpdateAt: undefined,
      nextPacketId: 1,
    };
  },
  onFrame(ctx, port, frame) {
    const config = ripConfig(ctx.device);
    const datagram = packetIn(frame)?.payload;
    if (!config || datagram?.kind !== 'udp' || datagram.dstPort !== UDP_PORT.rip) return;
    const interfaces = ipInterfaces(ctx.device, ctx, undefined);
    // RIPv1 only broadcasts, so a router pinned to it never joins RIPv2's group.
    const groups = config.version === 1 ? [] : [RIP_GROUP];
    const arrived = arrival(ctx, interfaces, port, frame, groups);
    if (arrived) onMessage(ctx, config, arrived);
  },
  onTimer(ctx, key) {
    const timer = parseTimer(key);
    if (timer) onTimer(ctx, timer);
  },
  onLinkChange: reconcile,
  onConfigChange: reconcile,
  routes(ctx): LearnedRoute[] {
    const learned: LearnedRoute[] = [];
    for (const route of ctx.state.routes.values()) {
      if (!route.from || route.metric >= RIP_INFINITY) continue;
      learned.push({
        source: 'rip',
        prefix: route.prefix,
        distance: ADMINISTRATIVE_DISTANCE.rip,
        metric: route.metric,
        via: route.from.address,
        interface: route.from.interface,
        ageMs: ctx.now - route.updatedAt,
      });
    }
    return learned;
  },
};
