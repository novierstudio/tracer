import type { PrefixLength } from '@/model';
import { compareAddresses, networkOf } from '../../l3/ipv4';
import {
  INITIAL_SEQUENCE,
  MAX_AGE,
  type Lsa,
  type LsaHeader,
  type LsaType,
  type RouterLink,
} from '../../pdu';
import {
  isBoundary,
  isStub,
  ospfConfig,
  same,
  seconds,
  timersOf,
  type OspfContext,
} from './context';
import { externalsWanted } from './external';
import { armRetransmit, floodAudience, send } from './send';
import {
  aged,
  atLeast,
  compareInstances,
  headerOf,
  lsaKey,
  timerKey,
  type Iface,
  type LsaBody,
  type Neighbor,
  type Process,
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

/**
 * The areas whose databases hold an LSA: its own area, or for an external LSA every area that is
 * not a stub area, since external LSAs flood through the whole AS.
 */
export function scopeOf(ctx: OspfContext, process: Process, area: number, lsa: Lsa): number[] {
  if (lsa.type !== 'external') return [area];
  const config = ospfConfig(ctx.device);
  return [...process.areas.keys()].filter((other) => !config || !isStub(config, other));
}

/** Installs a new instance of one of this router's own LSAs and floods it through its scope. */
function issue(ctx: OspfContext, process: Process, area: number, lsa: Lsa) {
  for (const target of scopeOf(ctx, process, area, lsa)) {
    databaseOf(process, target).set(lsaKey(lsa), { lsa, receivedAt: ctx.now });
    flood(ctx, process, target, lsa);
  }
}

/** What an LSA says, apart from the age and sequence number of this instance. */
const sameContent = (lsa: Lsa, body: LsaBody) =>
  same({ ...lsa, age: 0, sequence: 0 }, { ...body, age: 0, sequence: 0 });

/**
 * Brings this router's own LSAs of `types` in the area in line with `wanted`, by LSA key. One that
 * is new or changed goes out as a new instance, as does every one with `refresh`; one no longer
 * wanted is flushed at MaxAge. So calling this after any change is cheap.
 */
export function syncOwn(
  ctx: OspfContext,
  process: Process,
  area: number,
  types: readonly LsaType[],
  wanted: ReadonlyMap<string, LsaBody>,
  refresh: boolean,
) {
  const database = databaseOf(process, area);
  for (const [key, stored] of database) {
    const lsa = aged(stored, ctx.now);
    if (!types.includes(lsa.type) || lsa.advertisingRouter !== process.routerId) continue;
    if (!wanted.has(key) && lsa.age < MAX_AGE) issue(ctx, process, area, { ...lsa, age: MAX_AGE });
  }
  for (const [key, body] of wanted) {
    const stored = database.get(key);
    const current = stored && aged(stored, ctx.now);
    const fresh = current !== undefined && current.age < MAX_AGE;
    if (!refresh && fresh && sameContent(current, body)) continue;
    const sequence = current ? current.sequence + 1 : INITIAL_SEQUENCE;
    issue(ctx, process, area, { ...body, age: 0, sequence } as Lsa);
  }
}

/**
 * Keeps every area that is not a stub area holding the newest instance of each external LSA, as
 * a new area joins, and empties a stub area of them.
 */
function shareExternals(ctx: OspfContext, process: Process) {
  const newest = new Map<string, Stored>();
  for (const database of process.areas.values()) {
    for (const [key, stored] of database) {
      if (stored.lsa.type !== 'external') continue;
      const held = newest.get(key);
      if (!held || compareInstances(aged(stored, ctx.now), aged(held, ctx.now)) > 0)
        newest.set(key, stored);
    }
  }
  const config = ospfConfig(ctx.device);
  for (const [area, database] of process.areas) {
    const stub = config !== undefined && isStub(config, area);
    for (const [key, stored] of newest) {
      if (stub) database.delete(key);
      else if (database.get(key) !== stored) database.set(key, stored);
    }
  }
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
 * Brings this router's own LSAs in line with its interfaces, neighbours and config: a router LSA
 * in each area it has an interface in, a network LSA for each network where it is DR with a full
 * neighbour, and an external LSA for each route it redistributes. One it no longer originates is
 * flushed at MaxAge. A new instance goes out only when the content changed, or with `refresh`.
 * The summaries an area border router originates follow SPF, which this schedules.
 */
export function originate(ctx: OspfContext, process: Process, refresh = false) {
  const config = ospfConfig(ctx.device);
  if (!config) return;
  const { routerId } = process;
  if (refresh) process.refreshPending = true;
  const areas = new Set([...process.interfaces.values()].map((iface) => iface.area));
  for (const area of process.areas.keys()) if (!areas.has(area)) process.areas.delete(area);
  for (const area of areas) databaseOf(process, area);
  shareExternals(ctx, process);
  process.abr = areas.size > 1;
  process.asbr = isBoundary(config);

  for (const area of areas) {
    const router: LsaBody = {
      type: 'router',
      id: routerId,
      advertisingRouter: routerId,
      abr: process.abr,
      asbr: process.asbr,
      links: routerLinks(process, area),
    };
    syncOwn(ctx, process, area, ['router'], new Map([[lsaKey(router), router]]), refresh);

    const networks = new Map<string, LsaBody>();
    for (const iface of process.interfaces.values()) {
      if (iface.area !== area || iface.type !== 'broadcast' || iface.state !== 'dr') continue;
      const full = [...iface.neighbors.values()].filter((neighbor) => neighbor.state === 'full');
      if (full.length === 0) continue;
      const network: LsaBody = {
        type: 'network',
        id: iface.ip.cidr.address,
        advertisingRouter: routerId,
        prefixLength: iface.ip.cidr.prefixLength,
        attached: [routerId, ...full.map((neighbor) => neighbor.routerId)].sort(compareAddresses),
      };
      networks.set(lsaKey(network), network);
    }
    syncOwn(ctx, process, area, ['network'], networks, refresh);
  }

  const home = [...areas].find((area) => !isStub(config, area));
  if (home !== undefined) {
    syncOwn(ctx, process, home, ['external'], externalsWanted(ctx, process, config), refresh);
  }
  scheduleSpf(ctx, process);
}
