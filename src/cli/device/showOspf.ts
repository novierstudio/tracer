import type {
  OspfInterfaceState,
  OspfInterfaceStatus,
  OspfNeighborStatus,
  OspfNetworkType,
  OspfStatus,
  RoutingProtocols,
} from '../../engine/api';
import type { InterfaceId } from '../../model';
import { shortInterfaceName } from '../interfaces';
import type { IosDevice } from './context';
import { NO_ENGINE, routeAge } from './showRouting';

/** The running OSPF process, when the router has `router ospf` and the simulation runs it. */
function ospfOf(protocols: RoutingProtocols, device: IosDevice): OspfStatus | undefined {
  return device.kind === 'router' && device.config.ospf ? protocols.ospf : undefined;
}

/** How each interface state reads: in `show ip ospf interface brief`, and in the full block. */
const STATE: Record<OspfInterfaceState, { brief: string; full: string }> = {
  dr: { brief: 'DR', full: 'DR' },
  backup: { brief: 'BDR', full: 'BDR' },
  drother: { brief: 'DROTH', full: 'DROTHER' },
  'point-to-point': { brief: 'P2P', full: 'POINT_TO_POINT' },
  loopback: { brief: 'LOOP', full: 'LOOPBACK' },
  waiting: { brief: 'WAIT', full: 'WAITING' },
};

const NETWORK_TYPE: Record<OspfNetworkType, string> = {
  broadcast: 'BROADCAST',
  'point-to-point': 'POINT_TO_POINT',
  loopback: 'LOOPBACK',
};

const ROLE: Record<NonNullable<OspfNeighborStatus['role']>, { state: string; adjacent: string }> = {
  dr: { state: '/DR', adjacent: '  (Designated Router)' },
  bdr: { state: '/BDR', adjacent: '  (Backup Designated Router)' },
  drother: { state: '/DROTHER', adjacent: '' },
};

/** A countdown as IOS prints it, `00:00:33`. */
const countdown = (ms: number) => routeAge(Math.max(0, ms));

/** What IOS says while the process has no router ID to start with. */
function notRunning(ospf: OspfStatus): readonly string[] | undefined {
  return ospf.routerId === undefined
    ? [`%OSPF: Router process ${ospf.processId} is not running, please configure a router-id`]
    : undefined;
}

function neighborRow(neighbor: OspfNeighborStatus): string {
  const role = neighbor.role ? ROLE[neighbor.role].state : '/  -';
  // A point-to-point link elects no DR, so IOS shows the neighbour's priority as 0.
  const priority = neighbor.role ? neighbor.priority : 0;
  return [
    neighbor.routerId.padEnd(16),
    String(priority).padStart(3),
    '   ',
    (neighbor.state.toUpperCase() + role).padEnd(16),
    countdown(neighbor.deadMs).padEnd(12),
    neighbor.address.padEnd(16),
    neighbor.interface,
  ].join('');
}

/** `show ip ospf neighbor`: every neighbour on every OSPF interface. */
export function showIpOspfNeighbor(
  protocols: RoutingProtocols | undefined,
  device: IosDevice,
): readonly string[] {
  if (!protocols) return NO_ENGINE;
  const ospf = ospfOf(protocols, device);
  if (!ospf) return [];
  return (
    notRunning(ospf) ?? [
      '',
      'Neighbor ID     Pri   State           Dead Time   Address         Interface',
      ...ospf.interfaces.flatMap((entry) => entry.neighbors.map(neighborRow)),
    ]
  );
}

const fullCount = (neighbors: readonly OspfNeighborStatus[]) =>
  neighbors.filter((neighbor) => neighbor.state === 'full').length;

/** `show ip ospf interface brief`: one row per OSPF interface. */
export function showIpOspfInterfaceBrief(
  protocols: RoutingProtocols | undefined,
  device: IosDevice,
): readonly string[] {
  if (!protocols) return NO_ENGINE;
  const ospf = ospfOf(protocols, device);
  if (!ospf) return [];
  const row = (cells: readonly string[]) =>
    [13, 6, 16, 19, 6, 6]
      .map((width, i) => cells[i]!.padEnd(width))
      .concat(cells[6]!)
      .join('');
  return (
    notRunning(ospf) ?? [
      row(['Interface', 'PID', 'Area', 'IP Address/Mask', 'Cost', 'State', 'Nbrs F/C']),
      ...ospf.interfaces.map((entry) =>
        row([
          shortInterfaceName(entry.name),
          String(ospf.processId),
          String(entry.area),
          `${entry.cidr.address}/${entry.cidr.prefixLength}`,
          String(entry.cost),
          STATE[entry.state].brief,
          `${fullCount(entry.neighbors)}/${entry.neighbors.length}`,
        ]),
      ),
    ]
  );
}

function designatedLines(entry: OspfInterfaceStatus): string[] {
  const { dr, bdr } = entry;
  return [
    dr
      ? `  Designated Router (ID) ${dr.routerId}, Interface address ${dr.address}`
      : '  No designated router on this network',
    bdr
      ? `  Backup Designated router (ID) ${bdr.routerId}, Interface address ${bdr.address}`
      : '  No backup designated router on this network',
  ];
}

/** One interface's block of `show ip ospf interface`, with the timers it runs. */
function interfaceBlock(ospf: OspfStatus, entry: OspfInterfaceStatus): string[] {
  const head = [
    `${entry.name} is up, line protocol is up`,
    `  Internet Address ${entry.cidr.address}/${entry.cidr.prefixLength}, Area ${entry.area}`,
    `  Process ID ${ospf.processId}, Router ID ${ospf.routerId}, Network Type ${NETWORK_TYPE[entry.networkType]}, Cost: ${entry.cost}`,
  ];
  if (entry.networkType === 'loopback') {
    return [...head, '  Loopback interface is treated as a stub Host'];
  }
  const broadcast = entry.networkType === 'broadcast';
  const { hello, dead, wait, retransmit } = ospf.timers;
  const adjacent = entry.neighbors.filter((neighbor) => neighbor.state === 'full');
  return [
    ...head,
    `  Transmit Delay is 1 sec, State ${STATE[entry.state].full}${broadcast ? `, Priority ${entry.priority}` : ''}`,
    ...(broadcast ? designatedLines(entry) : []),
    `  Timer intervals configured, Hello ${hello}, Dead ${dead}, Wait ${wait}, Retransmit ${retransmit}`,
    entry.passive
      ? '    No Hellos (Passive interface)'
      : `    Hello due in ${countdown(entry.helloDueMs ?? 0)}`,
    `  Neighbor Count is ${entry.neighbors.length}, Adjacent neighbor count is ${adjacent.length}`,
    ...adjacent.map(
      (neighbor) =>
        `    Adjacent with neighbor ${neighbor.routerId}${neighbor.role ? ROLE[neighbor.role].adjacent : ''}`,
    ),
    '  Suppress hello for 0 neighbor(s)',
  ];
}

/** `show ip ospf interface [<name>]`: each OSPF interface in full, or only the one named. */
export function showIpOspfInterface(
  protocols: RoutingProtocols | undefined,
  device: IosDevice,
  only?: InterfaceId,
): readonly string[] {
  if (!protocols) return NO_ENGINE;
  const ospf = ospfOf(protocols, device);
  if (!ospf) return [];
  const running = notRunning(ospf);
  if (running) return running;
  const entries = ospf.interfaces.filter((entry) => only === undefined || entry.name === only);
  if (only !== undefined && entries.length === 0) return [`%OSPF: OSPF not enabled on ${only}`];
  return entries.flatMap((entry) => interfaceBlock(ospf, entry));
}
