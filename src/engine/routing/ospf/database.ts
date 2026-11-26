import type { Ipv4Address, PrefixLength } from '@/model';
import { compareAddresses, networkOf } from '../../l3/ipv4';
import {
  INITIAL_SEQUENCE,
  MAX_AGE,
  type Lsa,
  type LsaHeader,
  type NetworkLsa,
  type RouterLink,
  type RouterLsa,
} from '../../pdu';
import { same, seconds, timersOf, type OspfContext } from './context';
import { armRetransmit, floodAudience, send } from './send';
import { shortestPaths } from './spf';
import {
  aged,
  atLeast,
  headerOf,
  lsaKey,
  timerKey,
  type Iface,
  type Neighbor,
  type Process,
  type SpfRoute,
  type Stored,
} from './state';

export function databaseOf(process: Process, area: number): Map<string, Stored> {
  let database = process.areas.get(area);
  if (!database) process.areas.set(area, (database = new Map()));
  return database;
}

/** Every live LSA in the area by header, for a database description. */
export function summary(ctx: OspfContext, process: Process, area: number): LsaHeader[] {
  return [...databaseOf(process, area)]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([, stored]) => aged(stored, ctx.now))
    .filter((lsa) => lsa.age < MAX_AGE)
    .map(headerOf);
}

export function scheduleSpf(ctx: OspfContext, process: Process) {
  if (process.spfPending) return;
  process.spfPending = true;
  ctx.setTimer(timerKey({ kind: 'spf' }), seconds(timersOf(ctx).spfDelay));
}

/**
 * Sends an LSA on to every adjacent neighbour in its area but the one it came from, and keeps it
 * for each until acknowledged. On the network it came from, only the DR passes it on, since
 * everyone else heard it from the DR or will. Returns whether it went back out that interface,
 * which acknowledges it to the sender.
 */
export function flood(
  ctx: OspfContext,
  process: Process,
  area: number,
  lsa: Lsa,
  from?: { readonly iface: Iface; readonly neighbor: Neighbor },
): boolean {
  const key = lsaKey(lsa);
  let back = false;
  for (const iface of process.interfaces.values()) {
    if (iface.area !== area || iface.passive || iface.type === 'loopback') continue;
    const onArrival = iface === from?.iface;
    if (onArrival && (iface.state !== 'dr' || from.neighbor.address === iface.bdr)) continue;
    const targets = [...iface.neighbors.values()].filter(
      (neighbor) => atLeast(neighbor.state, 'exchange') && neighbor !== from?.neighbor,
    );
    if (targets.length === 0) continue;
    for (const neighbor of targets) {
      neighbor.unacked.set(key, lsa);
      armRetransmit(ctx, iface, neighbor);
    }
    send(ctx, process, iface, { type: 'lsu', lsas: [lsa] }, floodAudience(iface));
    back ||= onArrival;
  }
  return back;
}

/** Installs a new instance of one of this router's own LSAs and floods it. */
function issue(ctx: OspfContext, process: Process, area: number, lsa: Lsa) {
  databaseOf(process, area).set(lsaKey(lsa), { lsa, receivedAt: ctx.now });
  flood(ctx, process, area, lsa);
}

/** The links this router's LSA describes in an area. */
function routerLinks(process: Process, area: number): RouterLink[] {
  const links: RouterLink[] = [];
  for (const iface of process.interfaces.values()) {
    if (iface.area !== area) continue;
    const { cidr } = iface.ip;
    const metric = iface.cost;
    const stub = {
      type: 'stub',
      network: networkOf(cidr).address,
      prefixLength: cidr.prefixLength,
      metric,
    } as const;
    const full = [...iface.neighbors.values()].filter((neighbor) => neighbor.state === 'full');
    switch (iface.type) {
      case 'loopback':
        links.push({ ...stub, network: cidr.address, prefixLength: 32 as PrefixLength });
        break;
      case 'point-to-point':
        for (const neighbor of full) {
          links.push({
            type: 'point-to-point',
            neighbor: neighbor.routerId,
            address: cidr.address,
            metric,
          });
        }
        links.push(stub);
        break;
      case 'broadcast': {
        // A transit network once the DR is fully adjacent; until then, a stub.
        const transit =
          iface.state === 'dr'
            ? full.length > 0
            : full.some((neighbor) => neighbor.address === iface.dr);
        links.push(
          transit ? { type: 'transit', dr: iface.dr, address: cidr.address, metric } : stub,
        );
        break;
      }
    }
  }
  return links;
}

/**
 * Brings this router's own LSAs in line with its interfaces and neighbours: a router LSA in each
 * area it has an interface in, and a network LSA for each network where it is DR with a full
 * neighbour. One it no longer originates is flushed at MaxAge. A new instance goes out only when
 * the content changed, or with `refresh`, so calling this after any change is cheap.
 */
export function originate(ctx: OspfContext, process: Process, refresh = false) {
  const { routerId } = process;
  const areas = new Set([...process.interfaces.values()].map((iface) => iface.area));
  for (const area of process.areas.keys()) if (!areas.has(area)) process.areas.delete(area);

  for (const area of areas) {
    const database = databaseOf(process, area);
    const own = (type: Lsa['type'], id: Ipv4Address) => {
      const stored = database.get(lsaKey({ type, id, advertisingRouter: routerId }));
      return stored && aged(stored, ctx.now);
    };
    const nextSequence = (current: Lsa | undefined) =>
      current ? current.sequence + 1 : INITIAL_SEQUENCE;

    const links = routerLinks(process, area);
    const current = own('router', routerId);
    const stale = !current || current.age >= MAX_AGE || current.type !== 'router';
    if (refresh || stale || !same(current.links, links)) {
      const lsa: RouterLsa = {
        type: 'router',
        id: routerId,
        advertisingRouter: routerId,
        age: 0,
        sequence: nextSequence(current),
        links,
      };
      issue(ctx, process, area, lsa);
    }

    const wanted = new Map<string, Omit<NetworkLsa, 'age' | 'sequence'>>();
    for (const iface of process.interfaces.values()) {
      if (iface.area !== area || iface.type !== 'broadcast' || iface.state !== 'dr') continue;
      const full = [...iface.neighbors.values()].filter((neighbor) => neighbor.state === 'full');
      if (full.length === 0) continue;
      const network = {
        type: 'network',
        id: iface.ip.cidr.address,
        advertisingRouter: routerId,
        prefixLength: iface.ip.cidr.prefixLength,
        attached: [routerId, ...full.map((neighbor) => neighbor.routerId)].sort(compareAddresses),
      } as const;
      wanted.set(lsaKey(network), network);
    }
    for (const [key, stored] of database) {
      const lsa = aged(stored, ctx.now);
      if (lsa.type !== 'network' || lsa.advertisingRouter !== routerId) continue;
      if (!wanted.has(key) && lsa.age < MAX_AGE)
        issue(ctx, process, area, { ...lsa, age: MAX_AGE });
    }
    for (const network of wanted.values()) {
      const held = own('network', network.id);
      const fresh = held?.type === 'network' && held.age < MAX_AGE;
      if (
        !refresh &&
        fresh &&
        same(held.attached, network.attached) &&
        held.prefixLength === network.prefixLength
      )
        continue;
      issue(ctx, process, area, { ...network, age: 0, sequence: nextSequence(held) });
    }
  }
  scheduleSpf(ctx, process);
}

/** Runs SPF in each area and keeps the routes, each aged from when it last changed. */
export function runSpf(ctx: OspfContext, process: Process) {
  process.spfPending = false;
  const routes = new Map<string, SpfRoute>();
  const reached = new Set<Ipv4Address>();
  for (const [area, database] of process.areas) {
    const lsas = [...database.values()].map((stored) => aged(stored, ctx.now));
    const interfaces = [...process.interfaces.values()]
      .filter((iface) => iface.area === area)
      .map((iface) => ({ name: iface.name, address: iface.ip.cidr.address }));
    const result = shortestPaths(process.routerId, lsas, interfaces);
    for (const router of result.reached) reached.add(router);
    for (const { prefix, cost, hops } of result.paths) {
      const key = `${prefix.address}/${prefix.prefixLength}`;
      const held = routes.get(key);
      if (held && held.cost <= cost) continue;
      const before = process.routes.get(key);
      const unchanged = before && before.cost === cost && same(before.hops, hops);
      routes.set(key, { prefix, cost, hops, since: unchanged ? before.since : ctx.now });
    }
  }
  process.routes = routes;
  process.reached = [...reached].sort(compareAddresses);
}
