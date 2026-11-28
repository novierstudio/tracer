import type { InterfaceId, Ipv4Address, Ipv4Cidr } from '@/model';
import { compareAddresses, networkOf } from '../../l3/ipv4';
import { MAXIMUM_PATHS } from '../../l3/routes';
import { MAX_AGE, type Lsa, type NetworkLsa, type RouterLink, type RouterLsa } from '../../pdu';

export type Hop = { readonly via: Ipv4Address; readonly interface: InterfaceId };

/**
 * A network SPF found: what it costs, and the neighbours that start the shortest paths. A network
 * the root sits on has no hops: it is connected, but an area border router still summarizes it.
 */
export type SpfPath = { readonly prefix: Ipv4Cidr; readonly cost: number; readonly hops: Hop[] };

/** A router SPF reached, with the B and E bits of its router LSA. */
export type SpfRouter = {
  readonly id: Ipv4Address;
  readonly cost: number;
  readonly hops: Hop[];
  readonly abr: boolean;
  readonly asbr: boolean;
};

/** How far a vertex is, and through which neighbours. `direct` marks a network the root is on. */
type Reach = { cost: number; hops: Hop[]; direct?: InterfaceId };

const sameHop = (a: Hop, b: Hop) => a.via === b.via && a.interface === b.interface;

/** Equal paths add up, up to MAXIMUM_PATHS of them, ordered by next hop. */
function merge(held: readonly Hop[], more: readonly Hop[]): Hop[] {
  const hops = [...held];
  for (const hop of more) if (!hops.some((other) => sameHop(other, hop))) hops.push(hop);
  return hops.sort((a, b) => compareAddresses(a.via, b.via)).slice(0, MAXIMUM_PATHS);
}

const prefixKey = ({ address, prefixLength }: Ipv4Cidr) => `${address}/${prefixLength}`;

type TransitLink = Extract<RouterLink, { type: 'transit' }>;
type PointToPointLink = Extract<RouterLink, { type: 'point-to-point' }>;

/** A router's link to the network whose DR is at `dr`. */
const transitTo = (lsa: RouterLsa | undefined, dr: Ipv4Address) =>
  lsa?.links.find((link): link is TransitLink => link.type === 'transit' && link.dr === dr);

/** A router's point-to-point link to `neighbor`. */
const pointToPoint = (lsa: RouterLsa | undefined, neighbor: Ipv4Address) =>
  lsa?.links.find(
    (link): link is PointToPointLink =>
      link.type === 'point-to-point' && link.neighbor === neighbor,
  );

/**
 * Dijkstra over one area's database from `root`, as RFC 2328 section 16 runs it. Vertices are
 * routers, by their router LSAs, and multi-access networks, by their DR's network LSAs. A link
 * counts only when both ends list it, so a router that went away, whose LSA lingers, is cut off.
 * Each vertex inherits its parent's next hops, except next to the root, where the next hop is the
 * neighbour's address on the shared link. Then each reached network and stub link is a path.
 * `interfaces` are the root's own OSPF interfaces, to find the one a next hop is through.
 */
export function shortestPaths(
  root: Ipv4Address,
  lsas: readonly Lsa[],
  interfaces: readonly { readonly name: InterfaceId; readonly address: Ipv4Address }[],
): { paths: SpfPath[]; routers: SpfRouter[] } {
  const routers = new Map<Ipv4Address, RouterLsa>();
  const networks = new Map<Ipv4Address, NetworkLsa>();
  for (const lsa of lsas) {
    if (lsa.age >= MAX_AGE) continue;
    if (lsa.type === 'router') routers.set(lsa.advertisingRouter, lsa);
    else if (lsa.type === 'network') networks.set(lsa.id, lsa);
  }
  const ownInterface = (address: Ipv4Address) =>
    interfaces.find((iface) => iface.address === address)?.name;

  const reach = new Map<string, Reach>([[`router ${root}`, { cost: 0, hops: [] }]]);
  const done = new Set<string>();
  const relax = (key: string, cost: number, hops: Hop[], direct?: InterfaceId) => {
    if (done.has(key)) return;
    const held = reach.get(key);
    if (!held || cost < held.cost) reach.set(key, { cost, hops: merge([], hops), direct });
    else if (cost === held.cost) held.hops = merge(held.hops, hops);
  };

  for (;;) {
    let next: [string, Reach] | undefined;
    for (const entry of reach) {
      if (done.has(entry[0])) continue;
      if (
        !next ||
        entry[1].cost < next[1].cost ||
        (entry[1].cost === next[1].cost && entry[0] < next[0])
      )
        next = entry;
    }
    if (!next) break;
    const [key, { cost, hops, direct }] = next;
    done.add(key);
    const [kind, id] = key.split(' ') as ['router' | 'network', Ipv4Address];

    if (kind === 'network') {
      for (const attached of networks.get(id)?.attached ?? []) {
        const back = transitTo(routers.get(attached), id);
        if (!back) continue;
        const via = direct ? [{ via: back.address, interface: direct }] : hops;
        relax(`router ${attached}`, cost, via);
      }
      continue;
    }
    for (const link of routers.get(id)?.links ?? []) {
      if (link.type === 'point-to-point') {
        const back = pointToPoint(routers.get(link.neighbor), id);
        if (!back) continue;
        const exit = id === root ? ownInterface(link.address) : undefined;
        const via = id !== root ? hops : exit ? [{ via: back.address, interface: exit }] : [];
        relax(`router ${link.neighbor}`, cost + link.metric, via);
      } else if (link.type === 'transit') {
        if (!networks.get(link.dr)?.attached.includes(id)) continue;
        const exit = id === root ? ownInterface(link.address) : undefined;
        relax(`network ${link.dr}`, cost + link.metric, id === root ? [] : hops, exit);
      }
    }
  }

  const paths = new Map<string, SpfPath>();
  const add = (prefix: Ipv4Cidr, cost: number, hops: Hop[]) => {
    const key = prefixKey(prefix);
    const held = paths.get(key);
    if (!held || cost < held.cost) paths.set(key, { prefix, cost, hops });
    else if (cost === held.cost) paths.set(key, { ...held, hops: merge(held.hops, hops) });
  };
  const reached: SpfRouter[] = [];
  for (const [key, { cost, hops }] of reach) {
    const [kind, id] = key.split(' ') as ['router' | 'network', Ipv4Address];
    if (kind === 'network') {
      const prefixLength = networks.get(id)!.prefixLength;
      add(networkOf({ address: id, prefixLength }), cost, hops);
      continue;
    }
    const lsa = routers.get(id);
    if (!lsa) continue;
    if (id !== root) reached.push({ id, cost, hops, abr: lsa.abr, asbr: lsa.asbr });
    for (const link of lsa.links) {
      if (link.type !== 'stub') continue;
      add({ address: link.network, prefixLength: link.prefixLength }, cost + link.metric, hops);
    }
  }
  return {
    paths: [...paths.values()],
    routers: reached.sort((a, b) => compareAddresses(a.id, b.id)),
  };
}
