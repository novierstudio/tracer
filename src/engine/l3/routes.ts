import type {
  Device,
  InterfaceId,
  Ipv4Address,
  Ipv4Cidr,
  PrefixLength,
  StaticRoute,
} from '@/model';
import type { IpInterface } from './interfaces';
import { compareAddresses, inPrefix, networkOf } from './ipv4';

/** One line of the routing table, as `show ip route` would print it. */
export type Route =
  | { readonly source: 'connected'; readonly prefix: Ipv4Cidr; readonly interface: InterfaceId }
  /** A router's own address on a connected subnet, as IOS 15 lists it. */
  | { readonly source: 'local'; readonly prefix: Ipv4Cidr; readonly interface: InterfaceId }
  | {
      readonly source: 'static';
      readonly prefix: Ipv4Cidr;
      /** Administrative distance. */
      readonly distance: number;
      readonly nextHop: StaticRoute['nextHop'];
    };

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

const SOURCE_ORDER: Record<Route['source'], number> = { connected: 0, local: 1, static: 2 };

/** A host's default gateway is a static default route, as `route print` shows it. */
function configuredRoutes(device: Device): readonly StaticRoute[] {
  switch (device.kind) {
    case 'router':
      return device.config.staticRoutes;
    case 'pc':
    case 'server': {
      const { ipv4 } = device.config;
      return ipv4.mode === 'static' && ipv4.gateway
        ? [{ prefix: DEFAULT_ROUTE, nextHop: { kind: 'address', address: ipv4.gateway } }]
        : [];
    }
    case 'switch':
      return [];
    default: {
      const exhaustive: never = device;
      return exhaustive;
    }
  }
}

const distanceOf = (route: Route) => (route.source === 'static' ? route.distance : 0);

/** Longest prefix wins, then the lowest administrative distance. Local routes are not for forwarding. */
function bestRoute(routes: readonly Route[], destination: Ipv4Address): Route | undefined {
  let best: Route | undefined;
  for (const route of routes) {
    if (route.source === 'local' || !inPrefix(route.prefix, destination)) continue;
    const longer = !best || route.prefix.prefixLength > best.prefix.prefixLength;
    const closer =
      best?.prefix.prefixLength === route.prefix.prefixLength &&
      distanceOf(route) < distanceOf(best);
    if (longer || closer) best = route;
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
  if (!route || route.source === 'local') return undefined;
  const exit = (name: InterfaceId): NextHop | undefined => {
    const iface = interfaces.find((candidate) => candidate.name === name);
    return iface && { interface: iface, address: destination };
  };
  if (route.source === 'connected') return exit(route.interface);
  const hop = route.nextHop;
  return hop.kind === 'interface'
    ? exit(hop.interface)
    : resolve(routes, interfaces, hop.address, depth + 1);
}

/**
 * Where to send a packet for `destination`, or undefined when there is no route. A static route
 * through a next-hop address resolves through the table again; one through an exit interface
 * sends straight to the destination on that interface, as IOS does.
 */
export function nextHop(
  routes: readonly Route[],
  interfaces: readonly IpInterface[],
  destination: Ipv4Address,
): NextHop | undefined {
  return resolve(routes, interfaces, destination, 0);
}

/**
 * The routes in use: a connected route for each working interface, a local route for each of a
 * router's own addresses, and each static route whose next hop resolves or whose exit interface
 * works. Sorted by network, as `show ip route` lists them.
 */
export function routingTable(device: Device, interfaces: readonly IpInterface[]): Route[] {
  const candidates: Route[] = [];
  for (const iface of interfaces) {
    candidates.push({ source: 'connected', prefix: networkOf(iface.cidr), interface: iface.name });
    if (device.kind === 'router' && iface.cidr.prefixLength < 32) {
      const prefix = { address: iface.cidr.address, prefixLength: HOST_PREFIX };
      candidates.push({ source: 'local', prefix, interface: iface.name });
    }
  }
  for (const route of configuredRoutes(device)) {
    const { prefix, nextHop, distance = 1 } = route;
    candidates.push({ source: 'static', prefix: networkOf(prefix), distance, nextHop });
  }

  // A static route can only resolve through routes that are themselves in use, so drop the ones
  // that do not resolve until none are left to drop.
  let table = candidates;
  for (;;) {
    const usable = table.filter(
      (route) => route.source !== 'static' || resolvesThrough(table, interfaces, route.nextHop),
    );
    if (usable.length === table.length) break;
    table = usable;
  }
  return table.sort(
    (a, b) =>
      compareAddresses(a.prefix.address, b.prefix.address) ||
      a.prefix.prefixLength - b.prefix.prefixLength ||
      SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source],
  );
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
