import type { OspfConfig } from '@/model';
import { ms } from '../../core/time';
import { ipInterfaces } from '../../l3/interfaces';
import { matchesWildcard } from '../../l3/ipv4';
import type { DeviceContext } from '../../module';
import { bandwidthOf, pickRouterId, settingsOf } from '../interfaceMetrics';
import { dropNeighbor, electDr } from './adjacency';
import {
  LS_REFRESH_TIME,
  ospfConfig,
  REFERENCE_BANDWIDTH,
  same,
  seconds,
  timersOf,
  type OspfContext,
  type Router,
} from './context';
import { originate } from './database';
import { NO_ROUTER, timerKey, type Iface, type Process } from './state';
import type { OspfNetworkType } from './status';

type Plan = Pick<Iface, 'ip' | 'area' | 'type' | 'cost' | 'priority' | 'passive'>;

/**
 * The working interfaces OSPF runs on: each one the first matching `network` statement covers,
 * in that statement's area. Ethernet is broadcast, serial point-to-point.
 */
function plan(ctx: DeviceContext, device: Router, config: OspfConfig): Plan[] {
  return ipInterfaces(device, ctx, undefined).flatMap((ip): Plan[] => {
    const network = config.networks.find((candidate) =>
      matchesWildcard(ip.cidr.address, candidate.address, candidate.wildcard),
    );
    if (!network) return [];
    const type: OspfNetworkType =
      ip.medium.kind === 'loopback'
        ? 'loopback'
        : ip.medium.kind === 'serial'
          ? 'point-to-point'
          : 'broadcast';
    const settings = settingsOf(device, ip.name);
    const cost =
      settings?.ospfCost ?? Math.max(1, Math.floor(REFERENCE_BANDWIDTH / bandwidthOf(device, ip)));
    return [
      {
        ip,
        area: network.area,
        type,
        cost,
        priority: settings?.ospfPriority ?? 1,
        passive: config.passiveInterfaces.includes(ip.name),
      },
    ];
  });
}

function addInterface(ctx: OspfContext, process: Process, planned: Plan) {
  const iface: Iface = {
    ...planned,
    name: planned.ip.name,
    state:
      planned.type === 'loopback'
        ? 'loopback'
        : planned.type === 'point-to-point'
          ? 'point-to-point'
          : 'waiting',
    dr: NO_ROUTER,
    bdr: NO_ROUTER,
    neighbors: new Map(),
    helloAt: undefined,
  };
  process.interfaces.set(iface.name, iface);
  const { wait } = timersOf(ctx);
  if (iface.type === 'broadcast')
    ctx.setTimer(timerKey({ kind: 'wait', iface: iface.name }), seconds(wait));
  if (!iface.passive && iface.type !== 'loopback') {
    iface.helloAt = ctx.now;
    ctx.setTimer(timerKey({ kind: 'hello', iface: iface.name }), ms(0));
  }
}

function removeInterface(ctx: OspfContext, process: Process, iface: Iface) {
  for (const neighbor of [...iface.neighbors.values()]) {
    dropNeighbor(ctx, process, iface, neighbor, 'Interface down or detached');
  }
  ctx.clearTimer(timerKey({ kind: 'hello', iface: iface.name }));
  ctx.clearTimer(timerKey({ kind: 'wait', iface: iface.name }));
  process.interfaces.delete(iface.name);
}

/** Brings the process's interfaces in line with the config and the links. */
function syncInterfaces(ctx: OspfContext, process: Process, device: Router, config: OspfConfig) {
  const plans = new Map(plan(ctx, device, config).map((planned) => [planned.ip.name, planned]));
  for (const iface of [...process.interfaces.values()]) {
    const planned = plans.get(iface.name);
    const kept =
      planned !== undefined &&
      planned.area === iface.area &&
      planned.type === iface.type &&
      planned.passive === iface.passive &&
      same(planned.ip.cidr, iface.ip.cidr);
    if (!kept) removeInterface(ctx, process, iface);
  }
  for (const planned of plans.values()) {
    const iface = process.interfaces.get(planned.ip.name);
    if (!iface) {
      addInterface(ctx, process, planned);
      continue;
    }
    iface.ip = planned.ip;
    iface.cost = planned.cost;
    if (iface.priority !== planned.priority) {
      iface.priority = planned.priority;
      electDr(ctx, process, iface);
    }
  }
}

function stopProcess(ctx: OspfContext) {
  const { process } = ctx.state;
  if (!process) return;
  for (const iface of [...process.interfaces.values()]) removeInterface(ctx, process, iface);
  ctx.clearTimer(timerKey({ kind: 'spf' }));
  ctx.clearTimer(timerKey({ kind: 'refresh' }));
  ctx.state.process = undefined;
}

/**
 * Brings OSPF in line with the config, the links and the lab's timers. A new process number,
 * `router-id` or timer profile starts the process over. Without a router ID to take, it waits.
 */
export function reconcile(ctx: OspfContext) {
  const { device } = ctx;
  const config = ospfConfig(device);
  if (!config || (device.kind !== 'router' && device.kind !== 'switch')) {
    stopProcess(ctx);
    return;
  }
  const profile = ctx.settings.routingTimers;
  let { process } = ctx.state;
  if (
    process &&
    (process.id !== config.processId ||
      process.configuredId !== config.routerId ||
      process.timers !== profile)
  ) {
    stopProcess(ctx);
    process = undefined;
  }
  if (!process) {
    const routerId = pickRouterId(ctx, config.routerId);
    if (!routerId) return;
    process = {
      id: config.processId,
      routerId,
      configuredId: config.routerId,
      timers: profile,
      interfaces: new Map(),
      areas: new Map(),
      routes: new Map(),
      reached: [],
      spfPending: false,
    };
    ctx.state.process = process;
    ctx.setTimer(timerKey({ kind: 'refresh' }), seconds(LS_REFRESH_TIME));
  }
  syncInterfaces(ctx, process, device, config);
  originate(ctx, process);
}
