import type { Ipv4Address, Ipv4Cidr } from '@/model';
import { compareAddresses } from '../../l3/ipv4';
import { LS_INFINITY, MAX_AGE, type Lsa } from '../../pdu';
import { same, type OspfContext } from './context';
import { originateSummaries } from './summaries';
import { shortestPaths, type Hop, type SpfPath, type SpfRouter } from './spf';
import {
  aged,
  lsaKey,
  type BorderRouter,
  type Process,
  type RouteKind,
  type SpfRoute,
} from './state';

/** What SPF found in one area: its networks, the router's own among them, and its routers. */
export type AreaPaths = { readonly paths: SpfPath[]; readonly routers: SpfRouter[] };

/** A way to a network before it is a route: `forward` breaks ties between type 2 externals. */
type Candidate = {
  readonly prefix: Ipv4Cidr;
  readonly kind: RouteKind;
  readonly cost: number;
  readonly forward: number;
  hops: Hop[];
};

const RANK: Record<RouteKind, number> = { intra: 0, inter: 1, E1: 2, E2: 3 };

const prefixKey = ({ address, prefixLength }: Ipv4Cidr) => `${address}/${prefixLength}`;

/** The way to an AS boundary router: within an area, or through an area border router. */
type BoundaryPath = { readonly cost: number; readonly hops: Hop[]; readonly intra: boolean };

/**
 * RFC 2328's routing table calculation (section 16). SPF in each area finds the intra-area
 * routes. Summary LSAs give the inter-area ones: their border router's cost plus the summary's
 * metric. An area border router weighs only the backbone's summaries, so it never takes a route
 * back from the area it summarized it into. External LSAs give the rest by way of their AS
 * boundary router: a type 1 adds the cost to it, a type 2 keeps its own metric and breaks ties
 * by that cost. OSPF prefers intra-area, then inter-area, then type 1, then type 2, whatever
 * the cost. Each route keeps its age while it stays the same.
 */
export function runSpf(ctx: OspfContext, process: Process) {
  process.spfPending = false;
  process.spfRuns += 1;
  const self = process.routerId;
  const live = (area: number): Lsa[] =>
    [...(process.areas.get(area)?.values() ?? [])]
      .map((stored) => aged(stored, ctx.now))
      .filter((lsa) => lsa.age < MAX_AGE);

  const results = new Map<number, AreaPaths>();
  for (const area of process.areas.keys()) {
    const interfaces = [...process.interfaces.values()]
      .filter((iface) => iface.area === area)
      .map((iface) => ({ name: iface.name, address: iface.ip.cidr.address }));
    results.set(area, shortestPaths(self, live(area), interfaces));
  }

  const found = new Map<string, Candidate>();
  const offer = (candidate: Candidate) => {
    const key = prefixKey(candidate.prefix);
    const held = found.get(key);
    const order = held
      ? RANK[candidate.kind] - RANK[held.kind] ||
        candidate.cost - held.cost ||
        candidate.forward - held.forward
      : -1;
    if (order < 0) found.set(key, { ...candidate, hops: [...candidate.hops] });
    else if (order === 0) {
      for (const hop of candidate.hops) {
        if (!held!.hops.some((other) => other.via === hop.via && other.interface === hop.interface))
          held!.hops.push(hop);
      }
    }
  };

  const borderRouters: BorderRouter[] = [];
  const boundaries = new Map<Ipv4Address, BoundaryPath>();
  const reachBoundary = (id: Ipv4Address, path: BoundaryPath) => {
    const held = boundaries.get(id);
    if (
      !held ||
      (path.intra && !held.intra) ||
      (path.intra === held.intra && path.cost < held.cost)
    )
      boundaries.set(id, path);
  };
  for (const [area, { paths, routers }] of results) {
    for (const { prefix, cost, hops } of paths)
      offer({ prefix, kind: 'intra', cost, forward: 0, hops });
    for (const router of routers) {
      if (!router.abr && !router.asbr) continue;
      const { id, cost, hops, abr, asbr } = router;
      borderRouters.push({ routerId: id, cost, hops, abr, asbr, area, inter: false });
      if (asbr) reachBoundary(id, { cost, hops, intra: true });
    }
  }

  // A border router with a backbone area weighs the backbone's summaries only.
  const examined = process.abr && results.has(0) ? [0] : [...results.keys()];
  for (const area of examined) {
    const routers = results.get(area)!.routers;
    for (const lsa of live(area)) {
      if (lsa.type !== 'summary' && lsa.type !== 'asbr-summary') continue;
      if (lsa.advertisingRouter === self || lsa.metric >= LS_INFINITY) continue;
      const border = routers.find((router) => router.id === lsa.advertisingRouter);
      if (!border) continue;
      const cost = border.cost + lsa.metric;
      if (lsa.type === 'summary') {
        const prefix = { address: lsa.id, prefixLength: lsa.prefixLength };
        offer({ prefix, kind: 'inter', cost, forward: 0, hops: border.hops });
      } else if (!boundaries.get(lsa.id)?.intra) {
        reachBoundary(lsa.id, { cost, hops: border.hops, intra: false });
        const known = borderRouters.find((entry) => entry.routerId === lsa.id && entry.inter);
        if (!known || cost < known.cost) {
          if (known) borderRouters.splice(borderRouters.indexOf(known), 1);
          const entry = { routerId: lsa.id, cost, hops: border.hops, abr: false, asbr: true };
          borderRouters.push({ ...entry, area, inter: true });
        }
      }
    }
  }

  const externals = new Map<string, Lsa>();
  for (const area of results.keys()) {
    for (const lsa of live(area)) if (lsa.type === 'external') externals.set(lsaKey(lsa), lsa);
  }
  for (const lsa of externals.values()) {
    if (lsa.type !== 'external' || lsa.advertisingRouter === self) continue;
    if (lsa.metric >= LS_INFINITY) continue;
    const boundary = boundaries.get(lsa.advertisingRouter);
    if (!boundary) continue;
    const prefix = { address: lsa.id, prefixLength: lsa.prefixLength };
    const typeOne = lsa.metricType === 1;
    offer({
      prefix,
      kind: typeOne ? 'E1' : 'E2',
      cost: typeOne ? boundary.cost + lsa.metric : lsa.metric,
      forward: boundary.cost,
      hops: boundary.hops,
    });
  }

  const routes = new Map<string, SpfRoute>();
  for (const [key, { prefix, kind, cost, hops }] of found) {
    // A network with no next hop is one the router sits on: a connected route, not OSPF's.
    if (hops.length === 0) continue;
    hops.sort((a, b) => compareAddresses(a.via, b.via));
    const before = process.routes.get(key);
    const unchanged =
      before && before.kind === kind && before.cost === cost && same(before.hops, hops);
    routes.set(key, { prefix, kind, cost, hops, since: unchanged ? before.since : ctx.now });
  }
  process.routes = routes;
  const reached = new Set<Ipv4Address>();
  for (const { routers } of results.values()) for (const { id } of routers) reached.add(id);
  process.reached = [...reached].sort(compareAddresses);
  process.borderRouters = borderRouters.sort(
    (a, b) => Number(a.inter) - Number(b.inter) || compareAddresses(a.routerId, b.routerId),
  );

  originateSummaries(ctx, process, results, [...found.values()]);
  process.refreshPending = false;
}
