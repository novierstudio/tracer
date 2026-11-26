import type {
  EigrpPathStatus,
  EigrpStatus,
  EigrpTopologyEntry,
  RoutingProtocols,
} from '../../engine/api';
import { ipv4ToUint32, type EigrpConfig, type EigrpNetwork } from '../../model';
import type { IosDevice } from './context';
import { networkText } from './eigrpConfig';
import { neighborInterface } from './showIpv6';
import { NO_ENGINE, routeAge } from './showRouting';

/**
 * `show ip eigrp` and EIGRP's part of `show ip protocols`, as Packet Tracer prints them on an
 * IOS 15 router: its own `IP-EIGRP` titles and fixed columns, not real IOS 15's `EIGRP-IPv4`.
 */

/** The composite metric of a destination EIGRP cannot reach. */
const INFINITE_METRIC = 0xffffffff;

/** The running EIGRP process, when the router has `router eigrp` and the simulation runs it. */
function eigrpOf(protocols: RoutingProtocols, device: IosDevice): EigrpStatus | undefined {
  return device.config.eigrp ? protocols.eigrp : undefined;
}

/** `show ip eigrp neighbors`: the title, then one line per neighbour in the order they came up. */
export function showIpEigrpNeighbors(
  protocols: RoutingProtocols | undefined,
  device: IosDevice,
): readonly string[] {
  if (!protocols) return NO_ENGINE;
  const eigrp = eigrpOf(protocols, device);
  if (!eigrp) return [];
  const rows = eigrp.neighbors.map(
    (neighbor) =>
      String(neighbor.handle).padEnd(4) +
      neighbor.address.padEnd(16) +
      neighborInterface(neighbor.interface).padEnd(15) +
      String(Math.floor(neighbor.holdMs / 1000)).padEnd(5) +
      routeAge(neighbor.uptimeMs).padEnd(10) +
      // Packet Tracer shows a 40 ms SRTT, a 1 s RTO and an empty queue for every neighbour.
      '40'.padEnd(7) +
      '1000'.padEnd(6) +
      '0'.padEnd(4) +
      String(neighbor.sequence),
  );
  return [
    `IP-EIGRP neighbors for process ${eigrp.asn}`,
    ...(rows.length === 0
      ? []
      : [
          'H   Address         Interface      Hold Uptime    SRTT   RTO   Q   Seq',
          `${' '.repeat(35)}(sec)          (ms)        Cnt  Num`,
          ...rows,
        ]),
  ];
}

const distanceText = (distance: number) =>
  distance >= INFINITE_METRIC ? 'Inaccessible' : String(distance);

function pathLine(path: EigrpPathStatus): string {
  const indent = ' '.repeat(9);
  switch (path.kind) {
    case 'connected':
      return `${indent}via Connected, ${path.interface}`;
    case 'redistributed':
      return `${indent}via Rstatic (${path.distance}/0)`;
    case 'neighbor':
      return `${indent}via ${path.via} (${path.distance}/${path.reported}), ${path.interface}`;
  }
}

function entryLines(entry: EigrpTopologyEntry, allLinks: boolean): string[] {
  const { address, prefixLength } = entry.prefix;
  const code = entry.state === 'active' ? 'A' : 'P';
  // Without all-links, only successors and feasible successors: the paths DUAL may use.
  const paths = entry.paths.filter(
    (path) => allLinks || path.kind !== 'neighbor' || path.successor || path.feasible,
  );
  return [
    `${code} ${address}/${prefixLength}, ${entry.successors} successors, FD is ${distanceText(entry.feasibleDistance)}`,
    ...paths.map(pathLine),
  ];
}

/** `show ip eigrp topology [all-links]`: each destination DUAL knows, and its paths. */
export function showIpEigrpTopology(
  protocols: RoutingProtocols | undefined,
  device: IosDevice,
  allLinks = false,
): readonly string[] {
  if (!protocols) return NO_ENGINE;
  const eigrp = eigrpOf(protocols, device);
  if (!eigrp) return [];
  return [
    `IP-EIGRP Topology Table for AS ${eigrp.asn}/ID(${eigrp.routerId ?? '0.0.0.0'})`,
    '',
    'Codes: P - Passive, A - Active, U - Update, Q - Query, R - Reply,',
    '       r - Reply status',
    '',
    ...eigrp.topology.flatMap((entry) => entryLines(entry, allLinks)),
  ];
}

/** `show ip eigrp interfaces`: each interface EIGRP says hello out of, and its peers. */
export function showIpEigrpInterfaces(
  protocols: RoutingProtocols | undefined,
  device: IosDevice,
): readonly string[] {
  if (!protocols) return NO_ENGINE;
  const eigrp = eigrpOf(protocols, device);
  if (!eigrp) return [];
  return [
    `IP-EIGRP interfaces for process ${eigrp.asn}`,
    '',
    `${' '.repeat(24)}Xmit Queue   Mean   Pacing Time   Multicast    Pending`,
    'Interface        Peers  Un/Reliable  SRTT   Un/Reliable   Flow Timer   Routes',
    // Packet Tracer shows the same queue, SRTT and pacing figures on every interface.
    ...eigrp.interfaces.map(
      ({ name, peers }) =>
        `${neighborInterface(name).padEnd(17)}${String(peers).padStart(3)}        0/0      1236       0/10           0           0`,
    ),
  ];
}

/** A `network` line as `show ip protocols` lists it: as a prefix when its wildcard is a mask. */
function routingFor(network: EigrpNetwork): string {
  if (network.wildcard === undefined) return network.address;
  const wildcard = ipv4ToUint32(network.wildcard);
  // A mask's wildcard is all ones below its prefix: one less than a power of two.
  const contiguous = ((wildcard + 1) & wildcard) === 0;
  return contiguous ? `${network.address}/${Math.clz32(wildcard)}` : networkText(network);
}

/**
 * EIGRP's section of `show ip protocols`, as Packet Tracer prints it, quirks and all: two spaces
 * and a trailing one inside the quotes, `Redistributing` flush left, and each source's last
 * update as a raw tick count.
 */
export function eigrpSection(config: EigrpConfig, status: EigrpStatus): string[] {
  const [k1, k2, k3, k4, k5] = status.kValues;
  return [
    `Routing Protocol is "eigrp  ${config.asn} "`,
    '  Outgoing update filter list for all interfaces is not set',
    '  Incoming update filter list for all interfaces is not set',
    '  Default networks flagged in outgoing updates',
    '  Default networks accepted from incoming updates',
    `  EIGRP metric weight K1=${k1}, K2=${k2}, K3=${k3}, K4=${k4}, K5=${k5}`,
    '  EIGRP maximum hopcount 100',
    `  EIGRP maximum metric variance ${config.variance}`,
    `Redistributing: eigrp ${config.asn}${config.redistributeStatic ? ', static' : ''}`,
    '  Automatic network summarization is not in effect',
    '  Maximum path: 4',
    '  Routing for Networks:',
    ...config.networks.map((network) => `     ${routingFor(network)}`),
    ...(config.passiveInterfaces.length > 0
      ? ['  Passive Interface(s):', ...config.passiveInterfaces.map((id) => `    ${id}`)]
      : []),
    '  Routing Information Sources:',
    '    Gateway         Distance      Last Update',
    ...status.sources.map(
      ({ gateway, lastUpdateAt }) =>
        `    ${gateway.padEnd(16)}${'90'.padEnd(14)}${Math.floor(lastUpdateAt)}`,
    ),
    '  Distance: internal 90 external 170',
  ];
}
