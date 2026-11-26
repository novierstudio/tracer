import type {
  Device,
  InterfaceId,
  Ipv4Address,
  Ipv4Cidr,
  PrefixLength,
  StaticRoute,
} from '@/model';
import { gatewayOf, type HostAddressing } from './hostAddress';
import { routesPackets, type IpInterface } from './interfaces';
import { compareAddresses, inPrefix, networkOf } from './ipv4';

/**
 * A route a routing protocol learned from a neighbour: forward to `via`, out of `interface`. The
 * protocol's module offers it, and the routing table weighs it against every other source.
 */
export type LearnedRoute = {
  readonly source: 'rip' | 'ospf' | 'eigrp';
  readonly prefix: Ipv4Cidr;
  /** Administrative distance: how far the router trusts the source. Lower wins. */
  readonly distance: number;
  /**
   * The protocol's own cost: hops for RIP, the sum of interface costs for OSPF, the composite
   * metric for EIGRP.
   */
  readonly metric: number;
  /**
   * The metric the table weighs the path by, when it differs from `metric`: EIGRP's `variance`
   * offers worse paths at the best one's metric, so they share the load with it.
   */
  readonly rank?: number;
  /** A route another protocol brought into this one, as EIGRP's `D EX`. */
  readonly external?: true;
  /** The neighbour to forward to. */
  readonly via: Ipv4Address;
  readonly interface: InterfaceId;
  /** Since RIP last heard the route, or since OSPF installed it, as `show ip route` ages it. */
  readonly ageMs: number;
};

/** One line of the routing table, as `show ip route` would print it. */
export type Route =
  | { readonly source: 'connected'; readonly prefix: Ipv4Cidr; readonly interface: InterfaceId }
  /** A router's own address on a connected subnet, as IOS 15 lists it. */
  | { readonly source: 'local'; readonly prefix: Ipv4Cidr; readonly interface: InterfaceId }
  | {
      readonly source: 'static';
      readonly prefix: Ipv4Cidr;
      readonly distance: number;
      readonly nextHop: StaticRoute['nextHop'];
    }
  | LearnedRoute;

/** IOS's default administrative distance for each source a route can come from. */
export const ADMINISTRATIVE_DISTANCE = {
  connected: 0,
  static: 1,
  eigrp: 90,
  ospf: 110,
  rip: 120,
} as const satisfies Record<Exclude<Route['source'], 'local'>, number>;

/** Where to hand a packet: out this interface, to the neighbour at this address. */
export type NextHop = { readonly interface: IpInterface; readonly address: Ipv4Address };

// Literals, not schema parses, so the worker bundle does not pull in zod and the model schemas.
const DEFAULT_ROUTE: Ipv4Cidr = {
  address: '0.0.0.0' as Ipv4Address,
  prefixLength: 0 as PrefixLength,
};

const HOST_PREFIX = 32 as PrefixLength;

/** IOS gives up resolving a next hop through other static routes after this many levels. */
const MAX_RECURSION = 8;

/** IOS installs up to this many equal routes to one network, as `maximum-paths 4` says. */
export const MAXIMUM_PATHS = 4;

const SOURCE_ORDER: Record<Route['source'], number> = {
  connected: 0,
  local: 1,
  static: 2,
  eigrp: 3,
  ospf: 4,
  rip: 5,
};

/**
 * A host's default gateway, from its config or its DHCP lease, is a static default route, as
 * `route print` shows it. So is a switch's `ip default-gateway`, which its management interface
 * uses until `ip routing` turns on its static routes instead.
 */
function configuredRoutes(
  device: Device,
  host: HostAddressing | undefined,
): readonly StaticRoute[] {
  switch (device.kind) {
    case 'router':
      return device.config.staticRoutes;
    case 'pc':
    case 'server': {
      const gateway = host && gatewayOf(host);
      return gateway
        ? [{ prefix: DEFAULT_ROUTE, nextHop: { kind: 'address', address: gateway } }]
        : [];
    }
    case 'switch': {
      if (device.config.ipRouting) return device.config.staticRoutes ?? [];
      const gateway = device.config.defaultGateway;
      return gateway
        ? [{ prefix: DEFAULT_ROUTE, nextHop: { kind: 'address', address: gateway } }]
        : [];
    }
    case 'hub':
      return [];
    default: {
      const exhaustive: never = device;
      return exhaustive;
    }
  }
}

const distanceOf = (route: Route) => ('distance' in route ? route.distance : 0);
const metricOf = (route: Route) => ('metric' in route ? (route.rank ?? route.metric) : 0);
const prefixKey = ({ prefix }: Route) => `${prefix.address}/${prefix.prefixLength}`;

/** The better of two routes to one network: the lower administrative distance, then metric. */
const preference = (a: Route, b: Route) =>
  distanceOf(a) - distanceOf(b) || metricOf(a) - metricOf(b);

/**
 * The routes IOS installs from the candidates: for each network, those with the lowest
 * administrative distance, then the lowest metric, up to MAXIMUM_PATHS of them. A local route is
 * the router's own address, not a way to reach one, so it never competes.
 */
function install(candidates: readonly Route[]): Route[] {
  const best = new Map<string, Route[]>();
  for (const route of candidates) {
    const key = route.source === 'local' ? `local ${prefixKey(route)}` : prefixKey(route);
    const held = best.get(key);
    const order = held ? preference(route, held[0]!) : -1;
    if (order < 0) best.set(key, [route]);
    else if (order === 0 && held!.length < MAXIMUM_PATHS) held!.push(route);
  }
  return [...best.values()].flat();
}

/** The longest prefix that covers the destination. Local routes are not for forwarding. */
function bestRoute(routes: readonly Route[], destination: Ipv4Address): Route | undefined {
  let best: Route | undefined;
  for (const route of routes) {
    if (route.source === 'local' || !inPrefix(route.prefix, destination)) continue;
    if (!best || route.prefix.prefixLength > best.prefix.prefixLength) best = route;
  }
  return best;
}

function resolve(
  routes: readonly Route[],
  interfaces: readonly IpInterface[],
  destination: Ipv4Address,
  depth: number,
): NextHop | undefined {
  const route = depth <= MAX_RECURSION ? bestRoute(routes, destination) : undefined;
  const exit = (name: InterfaceId, address: Ipv4Address): NextHop | undefined => {
    const iface = interfaces.find((candidate) => candidate.name === name);
    return iface && { interface: iface, address };
  };
  switch (route?.source) {
    case undefined:
    case 'local':
      return undefined;
    case 'connected':
      return exit(route.interface, destination);
    case 'rip':
    case 'ospf':
    case 'eigrp':
      return exit(route.interface, route.via);
    case 'static': {
      const hop = route.nextHop;
      return hop.kind === 'interface'
        ? exit(hop.interface, destination)
        : resolve(routes, interfaces, hop.address, depth + 1);
    }
  }
}

/**
 * Where to send a packet for `destination` by the routing table `routes`, or undefined when there
 * is no route. A static route through a next-hop address resolves through the table again; one
 * through an exit interface sends straight to the destination on that interface, as IOS does. Of
 * equal paths to one network, the first is taken.
 */
export function nextHop(
  routes: readonly Route[],
  interfaces: readonly IpInterface[],
  destination: Ipv4Address,
): NextHop | undefined {
  return resolve(routes, interfaces, destination, 0);
}

function resolvesThrough(
  routes: readonly Route[],
  interfaces: readonly IpInterface[],
  hop: StaticRoute['nextHop'],
): boolean {
  return hop.kind === 'interface'
    ? interfaces.some((iface) => iface.name === hop.interface)
    : resolve(routes, interfaces, hop.address, 1) !== undefined;
}

/** Orders routes as `show ip route` lists them: by network, then source, then next hop. */
function compareRoutes(a: Route, b: Route): number {
  const byHop =
    'via' in a && 'via' in b
      ? compareAddresses(a.via, b.via) || a.interface.localeCompare(b.interface)
      : 0;
  return (
    compareAddresses(a.prefix.address, b.prefix.address) ||
    a.prefix.prefixLength - b.prefix.prefixLength ||
    SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source] ||
    byHop
  );
}

/**
 * The routing table: from every candidate route, the best to each network. The candidates are a
 * connected route for each working interface and a local route for each of a router's own
 * addresses, as for a switch with `ip routing`, each static route, and the routes the device's routing protocols learned. A route
 * out of an interface that is down is no candidate, and a static route is installed only while
 * its next hop resolves through the table. Sorted by network, as `show ip route` lists it. A host's
 * gateway is `host`'s, from its config or its DHCP lease.
 */
export function routingTable(
  device: Device,
  interfaces: readonly IpInterface[],
  host: HostAddressing | undefined,
  learned: readonly LearnedRoute[] = [],
): Route[] {
  let candidates: Route[] = [];
  for (const iface of interfaces) {
    candidates.push({ source: 'connected', prefix: networkOf(iface.cidr), interface: iface.name });
    if (routesPackets(device) && iface.cidr.prefixLength < 32) {
      const prefix = { address: iface.cidr.address, prefixLength: HOST_PREFIX };
      candidates.push({ source: 'local', prefix, interface: iface.name });
    }
  }
  for (const route of configuredRoutes(device, host)) {
    const { prefix, nextHop, distance = ADMINISTRATIVE_DISTANCE.static } = route;
    candidates.push({ source: 'static', prefix: networkOf(prefix), distance, nextHop });
  }
  const working = new Set(interfaces.map((iface) => iface.name));
  candidates.push(...learned.filter((route) => working.has(route.interface)));

  // A static route resolves only through routes that are installed, and dropping one can install
  // another, such as a floating static route behind it. Drop the ones that do not resolve until
  // none are left to drop.
  for (;;) {
    const table = install(candidates);
    const stranded = new Set(
      table.filter(
        (route) => route.source === 'static' && !resolvesThrough(table, interfaces, route.nextHop),
      ),
    );
    if (stranded.size === 0) return table.sort(compareRoutes);
    candidates = candidates.filter((route) => !stranded.has(route));
  }
}
