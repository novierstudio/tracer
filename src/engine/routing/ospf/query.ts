import type { Ipv4Address } from '@/model';
import { ipInterfaces } from '../../l3/interfaces';
import { compareAddresses } from '../../l3/ipv4';
import { ospfConfig, timersOf, type OspfContext } from './context';
import { MAX_AGE, type Lsa } from '../../pdu';
import { aged, lsaKey, NO_ROUTER, type Iface, type Process } from './state';
import type { OspfDesignated, OspfInterfaceStatus, OspfLsaStatus, OspfStatus } from './status';
import { lsaChecksum } from './wire';

function designated(
  process: Process,
  iface: Iface,
  address: Ipv4Address,
): OspfDesignated | undefined {
  if (address === NO_ROUTER) return undefined;
  if (address === iface.ip.cidr.address) return { routerId: process.routerId, address };
  for (const neighbor of iface.neighbors.values()) {
    if (neighbor.address === address) return { routerId: neighbor.routerId, address };
  }
  return undefined;
}

function interfaceStatus(ctx: OspfContext, process: Process, iface: Iface): OspfInterfaceStatus {
  return {
    name: iface.name,
    cidr: iface.ip.cidr,
    area: iface.area,
    cost: iface.cost,
    networkType: iface.type,
    state: iface.state,
    priority: iface.priority,
    passive: iface.passive,
    dr: designated(process, iface, iface.dr),
    bdr: designated(process, iface, iface.bdr),
    helloDueMs: iface.helloAt === undefined ? undefined : Math.max(0, iface.helloAt - ctx.now),
    neighbors: [...iface.neighbors.values()]
      .sort((a, b) => compareAddresses(a.routerId, b.routerId))
      .map((neighbor) => ({
        routerId: neighbor.routerId,
        priority: neighbor.priority,
        state: neighbor.state,
        role:
          iface.type !== 'broadcast'
            ? undefined
            : neighbor.address === iface.dr
              ? 'dr'
              : neighbor.address === iface.bdr
                ? 'bdr'
                : 'drother',
        deadMs: Math.max(0, neighbor.deadAt - ctx.now),
        address: neighbor.address,
        interface: iface.name,
      })),
  };
}

/** The OSPF process's status, or undefined when the router has no `router ospf`. */
export function ospfStatus(ctx: OspfContext): OspfStatus | undefined {
  const config = ospfConfig(ctx.device);
  if (!config) return undefined;
  const { process } = ctx.state;
  const timers = timersOf(ctx);
  if (!process)
    return {
      processId: config.processId,
      routerId: undefined,
      timers,
      interfaces: [],
      sources: [],
      abr: false,
      asbr: false,
      spfRuns: 0,
      areas: [],
      externals: [],
      borderRouters: [],
    };
  const order = ipInterfaces(ctx.device, ctx, undefined).map((ip) => ip.name);
  const interfaces = [...process.interfaces.values()].sort(
    (a, b) => order.indexOf(a.name) - order.indexOf(b.name),
  );
  const sources = process.reached.flatMap((routerId) => {
    for (const database of process.areas.values()) {
      const stored = database.get(
        lsaKey({ type: 'router', id: routerId, advertisingRouter: routerId }),
      );
      if (stored) return [{ routerId, lastUpdateMs: ctx.now - stored.receivedAt }];
    }
    return [];
  });
  return {
    processId: process.id,
    routerId: process.routerId,
    timers,
    interfaces: interfaces.map((iface) => interfaceStatus(ctx, process, iface)),
    sources,
    abr: process.abr,
    asbr: process.asbr,
    spfRuns: process.spfRuns,
    areas: [...process.areas.keys()]
      .sort((a, b) => a - b)
      .map((id) => ({
        id,
        interfaces: interfaces.filter((iface) => iface.area === id).length,
        lsas: databaseStatus(ctx, process, id).filter(({ lsa }) => lsa.type !== 'external'),
      })),
    externals: [...process.areas.keys()]
      .flatMap((id) => databaseStatus(ctx, process, id))
      .filter(({ lsa }, i, all) => {
        if (lsa.type !== 'external') return false;
        return all.findIndex((other) => lsaKey(other.lsa) === lsaKey(lsa)) === i;
      }),
    borderRouters: process.borderRouters.flatMap(({ hops, ...entry }) =>
      hops.map((hop) => ({ ...entry, via: hop.via, interface: hop.interface })),
    ),
  };
}

const TYPE_ORDER: Record<Lsa['type'], number> = {
  router: 1,
  network: 2,
  summary: 3,
  'asbr-summary': 4,
  external: 5,
};

/** The area's live LSAs, aged to now, as `show ip ospf database` orders them. */
function databaseStatus(ctx: OspfContext, process: Process, area: number): OspfLsaStatus[] {
  return [...(process.areas.get(area)?.values() ?? [])]
    .map((stored) => aged(stored, ctx.now))
    .filter((lsa) => lsa.age < MAX_AGE)
    .sort(
      (a, b) =>
        TYPE_ORDER[a.type] - TYPE_ORDER[b.type] ||
        compareAddresses(a.id, b.id) ||
        compareAddresses(a.advertisingRouter, b.advertisingRouter),
    )
    .map((lsa) => ({ lsa, checksum: lsaChecksum(lsa) }));
}
