import type { Ipv4Address, Ipv4Cidr, OspfAreaRange, PrefixLength } from '@/model';
import { inPrefix, networkOf } from '../../l3/ipv4';
import type { AreaPaths } from './calculate';
import { areaSettings, ospfConfig, type OspfContext } from './context';
import { syncOwn } from './database';
import { lsaKey, type LsaBody, type Process, type RouteKind } from './state';

/** What an area border router advertises into a stub area in place of external routes. */
const STUB_DEFAULT_COST = 1;

const DEFAULT_ROUTE: Ipv4Cidr = {
  address: '0.0.0.0' as Ipv4Address,
  prefixLength: 0 as PrefixLength,
};

const prefixKey = ({ address, prefixLength }: Ipv4Cidr) => `${address}/${prefixLength}`;

const covers = (range: Ipv4Cidr, prefix: Ipv4Cidr) =>
  range.prefixLength <= prefix.prefixLength && inPrefix(range, prefix.address);

/**
 * The summary LSAs an area border router attached to the backbone originates into each of its
 * areas (RFC 2328 section 12.4.3). Into an area go the networks of every other area, each
 * network inside an `area range` folded into one summary at the lowest cost among them, as IOS
 * does by default, and none for a network the area has itself; into a non-backbone area also the routes the router learned from the
 * backbone's summaries. Each AS boundary router it reaches gets an ASBR summary. A stub area
 * takes a default route instead of external routes and ASBR summaries, and with `no-summary`
 * nothing else. A router that is no such border router originates none, and flushes any it did.
 */
export function originateSummaries(
  ctx: OspfContext,
  process: Process,
  results: ReadonlyMap<number, AreaPaths>,
  routes: readonly { readonly prefix: Ipv4Cidr; readonly kind: RouteKind; readonly cost: number }[],
) {
  const config = ospfConfig(ctx.device);
  if (!config) return;
  const border = process.abr && results.has(0);
  for (const area of results.keys()) {
    const networks = new Map<string, LsaBody>();
    const boundaries = new Map<string, LsaBody>();
    const own = new Set(results.get(area)!.paths.map(({ prefix }) => prefixKey(prefix)));
    const advertise = (prefix: Ipv4Cidr, metric: number) => {
      if (own.has(prefixKey(prefix))) return;
      const lsa: LsaBody = {
        type: 'summary',
        id: prefix.address,
        advertisingRouter: process.routerId,
        prefixLength: prefix.prefixLength,
        metric,
      };
      const held = networks.get(lsaKey(lsa));
      if (!held || (held.type === 'summary' && metric < held.metric))
        networks.set(lsaKey(lsa), lsa);
    };
    const advertiseBoundary = (id: Ipv4Address, metric: number) => {
      const lsa: LsaBody = {
        type: 'asbr-summary',
        id,
        advertisingRouter: process.routerId,
        metric,
      };
      const held = boundaries.get(lsaKey(lsa));
      if (!held || (held.type === 'asbr-summary' && metric < held.metric))
        boundaries.set(lsaKey(lsa), lsa);
    };

    const stub = areaSettings(config, area)?.stub;
    if (border && stub !== 'no-summary') {
      for (const [other, { paths, routers }] of results) {
        if (other === area) continue;
        const ranges = areaSettings(config, other)?.ranges ?? [];
        const folded = new Map<OspfAreaRange, number>();
        for (const { prefix, cost } of paths) {
          const range = ranges.find((candidate) => covers(candidate.prefix, prefix));
          if (!range) advertise(prefix, cost);
          else if (range.advertise) folded.set(range, Math.min(cost, folded.get(range) ?? cost));
        }
        for (const [range, cost] of folded) advertise(networkOf(range.prefix), cost);
        if (stub) continue;
        for (const router of routers) if (router.asbr) advertiseBoundary(router.id, router.cost);
      }
      if (area !== 0) {
        for (const route of routes) if (route.kind === 'inter') advertise(route.prefix, route.cost);
        if (!stub) {
          for (const entry of process.borderRouters) {
            if (entry.inter) advertiseBoundary(entry.routerId, entry.cost);
          }
        }
      }
    }
    if (border && stub) advertise(DEFAULT_ROUTE, STUB_DEFAULT_COST);
    syncOwn(ctx, process, area, ['summary'], networks, process.refreshPending);
    syncOwn(ctx, process, area, ['asbr-summary'], boundaries, process.refreshPending);
  }
}
