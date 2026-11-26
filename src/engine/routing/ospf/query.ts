import type { Ipv4Address } from '@/model';
import { ipInterfaces } from '../../l3/interfaces';
import { compareAddresses } from '../../l3/ipv4';
import { ospfConfig, timersOf, type OspfContext } from './context';
import { lsaKey, NO_ROUTER, type Iface, type Process } from './state';
import type { OspfDesignated, OspfInterfaceStatus, OspfStatus } from './status';

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
  };
}
