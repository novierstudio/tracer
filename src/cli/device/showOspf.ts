import type {
  OspfInterfaceState,
  OspfInterfaceStatus,
  OspfLsaStatus,
  OspfNeighborStatus,
  OspfNetworkType,
  OspfStatus,
  RoutingProtocols,
} from '../../engine/api';
import type { Lsa } from '../../engine/pdu';
import type { InterfaceId, OspfAreaRange, OspfConfig } from '../../model';
import { shortInterfaceName } from '../interfaces';
import type { IosDevice } from './context';
import { NO_ENGINE, routeAge } from './showRouting';

/** The running OSPF process, when the router has `router ospf` and the simulation runs it. */
function ospfOf(protocols: RoutingProtocols, device: IosDevice): OspfStatus | undefined {
  return device.config.ospf ? protocols.ospf : undefined;
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

const hex = (value: number, digits: number) =>
  `0x${value.toString(16).toUpperCase().padStart(digits, '0')}`;

/** The process's header line, as the database and border router tables open. */
const routerHeader = (ospf: OspfStatus) =>
  `            OSPF Router with ID (${ospf.routerId}) (Process ID ${ospf.processId})`;

const sectionTitle = (title: string) => `                ${title}`;

/** IOS calls area 0 the backbone wherever it names an area in full. */
const areaName = (id: number) => (id === 0 ? 'BACKBONE(0)' : String(id));

const SECTIONS: readonly { type: Lsa['type']; title: string; extra?: string }[] = [
  { type: 'router', title: 'Router Link States', extra: 'Link count' },
  { type: 'network', title: 'Net Link States' },
  { type: 'summary', title: 'Summary Net Link States' },
  { type: 'asbr-summary', title: 'Summary ASB Link States' },
];

/** One LSA's row: link state ID, advertising router, age, sequence number, checksum, then `extra`. */
function lsaRow({ lsa, checksum }: OspfLsaStatus, extra?: string): string {
  return [
    lsa.id.padEnd(16),
    lsa.advertisingRouter.padEnd(16),
    String(lsa.age).padEnd(12),
    hex(lsa.sequence >>> 0, 8).padEnd(11),
    hex(checksum, 6),
    ...(extra === undefined ? [] : [` ${extra}`]),
  ].join('');
}

function lsaSection(title: string, extra: string | undefined, rows: readonly string[]): string[] {
  const head = `Link ID         ADV Router      Age         Seq#       Checksum${extra ? ` ${extra}` : ''}`;
  return [sectionTitle(title), '', head, ...rows, ''];
}

/**
 * `show ip ospf database`: each area's router, network, summary and ASBR summary LSAs, then the
 * external LSAs, which belong to the whole AS, as IOS lists them.
 */
export function showIpOspfDatabase(
  protocols: RoutingProtocols | undefined,
  device: IosDevice,
): readonly string[] {
  if (!protocols) return NO_ENGINE;
  const ospf = ospfOf(protocols, device);
  if (!ospf) return [];
  const running = notRunning(ospf);
  if (running) return running;
  const out = ['', routerHeader(ospf), ''];
  for (const area of ospf.areas) {
    for (const { type, title, extra } of SECTIONS) {
      const entries = area.lsas.filter(({ lsa }) => lsa.type === type);
      if (entries.length === 0) continue;
      const rows = entries.map((entry) =>
        lsaRow(entry, entry.lsa.type === 'router' ? String(entry.lsa.links.length) : undefined),
      );
      out.push(...lsaSection(`${title} (Area ${area.id})`, extra, rows));
    }
  }
  if (ospf.externals.length > 0) {
    const rows = ospf.externals.map((entry) =>
      lsaRow(entry, entry.lsa.type === 'external' ? String(entry.lsa.tag) : undefined),
    );
    out.push(...lsaSection('Type-5 AS External Link States', 'Tag', rows));
  }
  return out;
}

/** `show ip ospf border-routers`: the paths to each area border and AS boundary router. */
export function showIpOspfBorderRouters(
  protocols: RoutingProtocols | undefined,
  device: IosDevice,
): readonly string[] {
  if (!protocols) return NO_ENGINE;
  const ospf = ospfOf(protocols, device);
  if (!ospf) return [];
  const running = notRunning(ospf);
  if (running) return running;
  return [
    '',
    `OSPF Process ${ospf.processId} internal Routing Table`,
    '',
    'Codes: i - Intra-area route, I - Inter-area route',
    '',
    ...ospf.borderRouters.map((entry) => {
      const role = [entry.abr && 'ABR', entry.asbr && 'ASBR'].filter(Boolean).join('/');
      return `${entry.inter ? 'I' : 'i'} ${entry.routerId} [${entry.cost}] via ${entry.via}, ${entry.interface}, ${role}, Area ${entry.area}, SPF ${ospf.spfRuns}`;
    }),
  ];
}

/** `N normal N stub 0 nssa`, as `show ip ospf` and `show ip protocols` count the areas. */
export function areaCount(ospf: OspfStatus, config: OspfConfig): string {
  const stub = ospf.areas.filter(({ id }) =>
    config.areas?.some((entry) => entry.area === id && entry.stub !== undefined),
  ).length;
  const total = ospf.areas.length;
  return `Number of areas in this router is ${total}. ${total - stub} normal ${stub} stub 0 nssa`;
}

/** What `show ip ospf` and `show ip protocols` say of the routes the router redistributes. */
export function redistributionLines(config: OspfConfig, indent: string): string[] {
  const sources = (
    [
      ['connected', config.redistributeConnected],
      ['static', config.redistributeStatic],
    ] as const
  ).flatMap(([source, redistribution]) =>
    redistribution
      ? [
          `    ${source}${redistribution.metric === undefined ? '' : ` with metric mapped to ${redistribution.metric}`}${redistribution.subnets ? ', includes subnets in redistribution' : ''}`,
        ]
      : [],
  );
  return sources.length > 0 ? [`${indent}Redistributing External Routes from,`, ...sources] : [];
}

/** The role lines IOS prints for an area border or AS boundary router. */
export function roleLines(ospf: OspfStatus, indent: string): string[] {
  return [
    ...(ospf.abr ? [`${indent}It is an area border router`] : []),
    ...(ospf.asbr ? [`${indent}It is an autonomous system boundary router`] : []),
  ];
}

const checksumSum = (entries: readonly OspfLsaStatus[]) =>
  hex(
    entries.reduce((sum, { checksum }) => sum + checksum, 0),
    6,
  );

/** An `area range` as `show ip ospf` lists it: Active with its cost while it summarizes something. */
function rangeLine(ospf: OspfStatus, area: number, range: OspfAreaRange): string {
  const prefix = `${range.prefix.address}/${range.prefix.prefixLength}`;
  if (!range.advertise) return `           ${prefix} Passive DoNotAdvertise`;
  const summary = ospf.areas
    .filter(({ id }) => id !== area)
    .flatMap(({ lsas }) => lsas)
    .find(
      ({ lsa }) =>
        lsa.type === 'summary' &&
        lsa.advertisingRouter === ospf.routerId &&
        lsa.id === range.prefix.address &&
        lsa.prefixLength === range.prefix.prefixLength,
    );
  const active = summary?.lsa.type === 'summary' ? `Active(${summary.lsa.metric})` : 'Passive';
  return `           ${prefix} ${active} Advertise`;
}

/** `show ip ospf`: the process, then each area it has interfaces in. */
export function showIpOspf(
  protocols: RoutingProtocols | undefined,
  device: IosDevice,
): readonly string[] {
  if (!protocols) return NO_ENGINE;
  const ospf = ospfOf(protocols, device);
  const config = device.config.ospf;
  if (!ospf || !config) return [];
  const running = notRunning(ospf);
  if (running) return running;
  const { spfDelay } = ospf.timers;
  const out = [
    ` Routing Process "ospf ${ospf.processId}" with ID ${ospf.routerId}`,
    ' Supports only single TOS(TOS0) routes',
    ' Supports opaque LSA',
    ...roleLines(ospf, ' '),
    ...redistributionLines(config, ' '),
    ` SPF schedule delay ${spfDelay} secs, Hold time between two SPFs 10 secs`,
    ' Minimum LSA interval 5 secs. Minimum LSA arrival 1 secs',
    ` Number of external LSA ${ospf.externals.length}. Checksum Sum ${checksumSum(ospf.externals)}`,
    ' Number of opaque AS LSA 0. Checksum Sum 0x000000',
    ' Number of DCbitless external and opaque AS LSA 0',
    ' Number of DoNotAge external and opaque AS LSA 0',
    ` ${areaCount(ospf, config)}`,
    ' External flood list length 0',
  ];
  for (const area of ospf.areas) {
    const settings = config.areas?.find((entry) => entry.area === area.id);
    out.push(
      `    Area ${areaName(area.id)}`,
      `        Number of interfaces in this area is ${area.interfaces}`,
      ...(settings?.stub === undefined
        ? []
        : [
            `        It is a stub area${settings.stub === 'no-summary' ? ', no summary LSA in this area' : ''}`,
            ...(ospf.abr ? ['          generates stub default route with cost 1'] : []),
          ]),
      '        Area has no authentication',
      `        SPF algorithm executed ${ospf.spfRuns} times`,
      '        Area ranges are',
      ...(settings?.ranges ?? []).map((range) => rangeLine(ospf, area.id, range)),
      `        Number of LSA ${area.lsas.length}. Checksum Sum ${checksumSum(area.lsas)}`,
      '        Number of opaque link LSA 0. Checksum Sum 0x000000',
      '        Number of DCbitless LSA 0',
      '        Number of indication LSA 0',
      '        Number of DoNotAge LSA 0',
      '        Flood list length 0',
    );
  }
  return out;
}
