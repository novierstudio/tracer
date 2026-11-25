import type {
  PortRole,
  PortState,
  SpanningTreePort,
  SpanningTreeVlan,
  StpTimes,
} from '../../engine/api';
import { formatVlans, type VlanRange } from '../../model';
import { shortInterfaceName } from '../interfaces';
import { ciscoMac } from './show';

const NO_ENGINE = ['% The simulation is not running, so there is no live state to show.'];

const ROLE: Record<PortRole, string> = {
  root: 'Root',
  designated: 'Desg',
  alternate: 'Altn',
  backup: 'Back',
};

const STATUS: Record<PortState, string> = {
  blocking: 'BLK',
  listening: 'LIS',
  learning: 'LRN',
  forwarding: 'FWD',
};

const INDENT = ' '.repeat(13);

const timesLine = ({ hello, maxAge, forwardDelay }: StpTimes) =>
  `${INDENT}Hello Time  ${hello} sec  Max Age ${maxAge} sec  Forward Delay ${forwardDelay} sec`;

const row = (cells: readonly [string, string, string, string, string, string]) =>
  [
    cells[0].padEnd(16),
    cells[1].padEnd(4),
    cells[2].padEnd(3),
    cells[3].padEnd(9),
    cells[4].padEnd(8),
    cells[5],
  ]
    .join(' ')
    .trimEnd();

function portRow(port: SpanningTreePort): string {
  return row([
    shortInterfaceName(port.port),
    ROLE[port.role],
    STATUS[port.state],
    String(port.cost),
    `${port.id.priority}.${port.id.number}`,
    port.edge ? 'P2p Edge' : 'P2p',
  ]);
}

/** One VLAN's block of `show spanning-tree`, as IOS prints it for PVST+. */
function instanceBlock(tree: SpanningTreeVlan): string[] {
  const { vlan, root, bridge, rootPort } = tree;
  return [
    `VLAN${String(vlan).padStart(4, '0')}`,
    '  Spanning tree enabled protocol ieee',
    `  Root ID    Priority    ${root.priority}`,
    `${INDENT}Address     ${ciscoMac(root.mac)}`,
    ...(rootPort
      ? [
          `${INDENT}Cost        ${tree.rootCost}`,
          `${INDENT}Port        ${rootPort.id.number}(${rootPort.port})`,
        ]
      : [`${INDENT}This bridge is the root`]),
    timesLine(tree.times),
    '',
    `  Bridge ID  Priority    ${bridge.priority}  (priority ${bridge.priority - vlan} sys-id-ext ${vlan})`,
    `${INDENT}Address     ${ciscoMac(bridge.mac)}`,
    timesLine(tree.bridgeTimes),
    `${INDENT}Aging Time  ${tree.agingTime} sec`,
    '',
    row(['Interface', 'Role', 'Sts', 'Cost', 'Prio.Nbr', 'Type']),
    row(['-'.repeat(16), '----', '---', '-'.repeat(9), '-'.repeat(8), '-'.repeat(32)]),
    ...tree.ports.map(portRow),
  ];
}

/**
 * `show spanning-tree [vlan <list>]`: each VLAN's root and bridge IDs and its ports' roles and
 * states. Without `only`, every VLAN the switch runs a tree for.
 */
export function showSpanningTree(
  trees: readonly SpanningTreeVlan[] | undefined,
  only?: readonly VlanRange[],
): readonly string[] {
  if (!trees) return NO_ENGINE;
  const shown = only
    ? trees.filter(({ vlan }) => only.some((range) => range.first <= vlan && vlan <= range.last))
    : trees;
  if (shown.length === 0) {
    return only
      ? [`Spanning tree instance(s) for vlan ${formatVlans(only)} does not exist.`]
      : ['No spanning tree instance exists.'];
  }
  return shown.flatMap((tree, i) => [...(i === 0 ? [] : ['']), ...instanceBlock(tree)]);
}
