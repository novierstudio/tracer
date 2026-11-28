import type { Device, Ipv6StaticRoute } from '@/model';
import {
  compareIpv6,
  inIpv6Prefix,
  ipv6Prefix,
  isLinkLocal,
  type Ipv6Address,
  type Ipv6Cidr,
} from '@/model/ipv6';
import type { Ipv6Interface } from './interfaces';
import type { DefaultRouter } from './state';
import type { Ipv6Route } from './status';

/** Where to hand a packet: out this interface, to the neighbour at this address. */
export type NextHop6 = { readonly interface: Ipv6Interface; readonly address: Ipv6Address };

const DEFAULT_ROUTE: Ipv6Cidr = { address: '::' as Ipv6Address, prefixLength: 0 };

/** IOS gives up resolving a next hop through other static routes after this many levels. */
const MAX_RECURSION = 8;

const key = ({ address, prefixLength }: Ipv6Cidr) => `${address}/${prefixLength}`;

/**
 * A host's default gateway, static or from a router advertisement, is a static default route out
 * of its one interface. A router's are its `ipv6 route` lines.
 */
function configuredRoutes(
  device: Device,
  interfaces: readonly Ipv6Interface[],
  defaultRouter: DefaultRouter | undefined,
): readonly Ipv6StaticRoute[] {
  switch (device.kind) {
    case 'router':
      return device.config.ipv6StaticRoutes ?? [];
    case 'pc':
    case 'server': {
      const [iface] = interfaces;
      const ipv6 = device.config.ipv6;
      const gateway =
        ipv6?.mode === 'static'
          ? ipv6.gateway
          : ipv6?.mode === 'auto'
            ? defaultRouter?.address
            : undefined;
      if (!gateway || !iface) return [];
      return [
        {
          prefix: DEFAULT_ROUTE,
          nextHop: { kind: 'address', address: gateway, interface: iface.name },
        },
      ];
    }
    case 'switch':
    case 'hub':
    case 'accessPoint':
    case 'wirelessRouter':
    case 'lightweightAp':
    case 'wlc':
    case 'cellTower':
    case 'centralOffice':
      return [];
    default: {
      const exhaustive: never = device;
      return exhaustive;
    }
  }
}

/** The connected and local routes of the up interfaces: each global prefix, and each address. */
function connectedRoutes(interfaces: readonly Ipv6Interface[], router: boolean): Ipv6Route[] {
  const routes = new Map<string, Ipv6Route>();
  for (const iface of interfaces) {
    if (!iface.up) continue;
    for (const entry of iface.addresses) {
      const prefix = ipv6Prefix(entry);
      if (!routes.has(key(prefix))) {
        routes.set(key(prefix), { source: 'connected', prefix, interface: iface.name });
      }
      const local: Ipv6Cidr = { address: entry.address, prefixLength: 128 };
      // A host keeps no local routes: only a router lists its own addresses.
      if (router && !routes.has(key(local))) {
        routes.set(key(local), { source: 'local', prefix: local, interface: iface.name });
      }
    }
  }
  return [...routes.values()];
}

/** The longest prefix that holds `address`, among `routes`. */
function longestMatch(routes: readonly Ipv6Route[], address: Ipv6Address): Ipv6Route | undefined {
  let best: Ipv6Route | undefined;
  for (const route of routes) {
    if (!inIpv6Prefix(route.prefix, address)) continue;
    if (!best || route.prefix.prefixLength > best.prefix.prefixLength) best = route;
  }
  return best;
}

/** Where a route sends a packet for `dst`, following a recursive static route to its exit. */
function resolve(
  routes: readonly Ipv6Route[],
  interfaces: readonly Ipv6Interface[],
  route: Ipv6Route,
  dst: Ipv6Address,
  depth = 0,
): NextHop6 | undefined {
  const byName = (name: string) => interfaces.find((iface) => iface.up && iface.name === name);
  if (route.source !== 'static') {
    const iface = byName(route.interface);
    return iface && { interface: iface, address: dst };
  }
  const { nextHop } = route;
  if (nextHop.kind === 'interface') {
    const iface = byName(nextHop.interface);
    return iface && { interface: iface, address: dst };
  }
  if (nextHop.interface !== undefined) {
    const iface = byName(nextHop.interface);
    return iface && { interface: iface, address: nextHop.address };
  }
  if (depth >= MAX_RECURSION || isLinkLocal(nextHop.address)) return undefined;
  const via = longestMatch(
    routes.filter((other) => other !== route),
    nextHop.address,
  );
  if (!via) return undefined;
  const hop = resolve(routes, interfaces, via, nextHop.address, depth + 1);
  return hop && { interface: hop.interface, address: hop.address };
}

const ORDER: Record<Ipv6Route['source'], number> = { connected: 0, local: 1, static: 2 };

/** Orders routes as `show ipv6 route` lists them: by prefix, then connected before local. */
function byPrefix(a: Ipv6Route, b: Ipv6Route): number {
  return (
    compareIpv6(a.prefix.address, b.prefix.address) ||
    a.prefix.prefixLength - b.prefix.prefixLength ||
    ORDER[a.source] - ORDER[b.source]
  );
}

/**
 * The routes the device uses: connected and local routes of its up interfaces, and the static
 * routes whose next hop it can reach, the lower distance winning for one prefix. A connected
 * route always beats a static one to the same prefix.
 */
export function ipv6RoutingTable(
  device: Device,
  interfaces: readonly Ipv6Interface[],
  defaultRouter: DefaultRouter | undefined,
): Ipv6Route[] {
  const connected = connectedRoutes(interfaces, device.kind === 'router');
  const taken = new Set(connected.map((route) => key(route.prefix)));
  const candidates: Ipv6Route[] = configuredRoutes(device, interfaces, defaultRouter).map(
    ({ prefix, nextHop, distance = 1 }) => ({
      source: 'static',
      prefix: ipv6Prefix(prefix),
      distance,
      nextHop,
    }),
  );
  const statics = new Map<string, Ipv6Route>();
  for (const route of candidates) {
    if (taken.has(key(route.prefix))) continue;
    if (!resolve([...connected, ...candidates], interfaces, route, route.prefix.address)) continue;
    const held = statics.get(key(route.prefix));
    if (held?.source === 'static' && route.source === 'static' && held.distance <= route.distance)
      continue;
    statics.set(key(route.prefix), route);
  }
  return [...connected, ...statics.values()].sort(byPrefix);
}

/**
 * The next hop for a packet to `dst`, by the longest matching route. A link-local destination
 * goes out of the only up Ethernet interface, since nothing says which link it is on otherwise.
 */
export function nextHop6(
  routes: readonly Ipv6Route[],
  interfaces: readonly Ipv6Interface[],
  dst: Ipv6Address,
): NextHop6 | undefined {
  if (isLinkLocal(dst)) {
    const lans = interfaces.filter((iface) => iface.up && iface.medium.kind !== 'loopback');
    const [only] = lans;
    return lans.length === 1 && only ? { interface: only, address: dst } : undefined;
  }
  const route = longestMatch(routes, dst);
  return route && resolve(routes, interfaces, route, dst);
}
