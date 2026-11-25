import type { Draft } from 'immer';
import {
  BridgePriority,
  DEFAULT_BRIDGE_PRIORITY,
  PathCost,
  type PortId,
  type SwitchInterface,
  type VlanId,
  type VlanRange,
} from '../../model';
import type { ModeOf } from '../modes';
import { choice, keyword, num, vlanList } from '../params';
import { defineCommand } from '../tree';
import { INVALID_INPUT, type SwitchContext } from './context';
import { showSpanningTree } from './showSpanningTree';

const switchCommand = defineCommand<SwitchContext>();

const EXEC = ['user-exec', 'priv-exec'] as const;
const GLOBAL = ['global-config'] as const;
const IF = ['interface-config'] as const;

const NOTHING: readonly string[] = [];

const show = keyword('show', 'Show running system information');
const spanningTree = keyword('spanning-tree', 'Spanning Tree Subsystem');
const vlanKw = keyword('vlan', 'VLAN Switch Spanning Tree');
const vlans = vlanList('vlans', 'vlan range, example: 1,3-5,7,9-11');

/** `spanning-tree vlan <id> root`: the priority IOS sets when the root has the default one. */
const ROOT_PRIORITY = {
  primary: BridgePriority.parse(24576),
  secondary: BridgePriority.parse(28672),
};

const PORTFAST_WARNING = [
  '%Warning: portfast should only be enabled on ports connected to a single',
  ' host. Connecting hubs, concentrators, switches, bridges, etc... to this',
  ' interface  when portfast is enabled, can cause temporary bridging loops.',
  ' Use with CAUTION',
  '',
];

const portfastNote = (port: PortId) => [
  `%Portfast has been configured on ${port} but will only`,
  ' have effect when the interface is in a non-trunking mode.',
];

function eachVlan(ranges: readonly VlanRange[], visit: (vlan: VlanId) => void) {
  for (const { first, last } of ranges) {
    for (let vlan = first; vlan <= last; vlan++) visit(vlan as VlanId);
  }
}

/** Sets each VLAN's bridge priority. The default is stored as none, so it stays out of the config. */
function setPriority(ctx: SwitchContext, ranges: readonly VlanRange[], priority: BridgePriority) {
  const { config } = ctx.device;
  const priorities = { ...config.stpPriorities };
  eachVlan(ranges, (vlan) => {
    if (priority === DEFAULT_BRIDGE_PRIORITY) delete priorities[vlan];
    else priorities[vlan] = priority;
  });
  if (Object.keys(priorities).length > 0) config.stpPriorities = priorities;
  else delete config.stpPriorities;
  return NOTHING;
}

/** The switchports of the mode's interfaces, or undefined when a VLAN interface is among them. */
function switchportsOf(ctx: SwitchContext, mode: ModeOf<'interface-config'>) {
  const found: [PortId, Draft<SwitchInterface>][] = [];
  for (const id of mode.interfaces) {
    const port = ctx.device.config.interfaces[id as PortId];
    if (!port) return undefined;
    found.push([id as PortId, port]);
  }
  return found;
}

/** Applies `edit` to every switchport of the mode, or refuses the command if one is not a switchport. */
function eachSwitchport(
  ctx: SwitchContext,
  mode: ModeOf<'interface-config'>,
  edit: (port: Draft<SwitchInterface>) => void,
): readonly string[] {
  const ports = switchportsOf(ctx, mode);
  if (!ports) return ctx.reject(INVALID_INPUT);
  for (const [, port] of ports) edit(port);
  return NOTHING;
}

export const spanningTreeCommands = [
  switchCommand({
    modes: EXEC,
    path: [show, spanningTree],
    run: (_a, ctx) => ctx.query('spanningTree', (trees) => showSpanningTree(trees)),
  }),
  switchCommand({
    modes: EXEC,
    path: [show, spanningTree, vlanKw, vlans],
    run: ({ vlans: only }, ctx) =>
      ctx.query('spanningTree', (trees) => showSpanningTree(trees, only)),
  }),
  // PVST+ is the only mode, and the extended system ID is always on.
  switchCommand({
    modes: GLOBAL,
    path: [
      spanningTree,
      keyword('mode', 'Spanning tree operating mode'),
      choice('mode', { pvst: 'Per-Vlan spanning tree mode' }),
    ],
    run: () => NOTHING,
    no: () => NOTHING,
  }),
  switchCommand({
    modes: GLOBAL,
    path: [
      spanningTree,
      keyword('extend', 'Spanning Tree 802.1t extensions'),
      keyword('system-id', 'Extend system-id into priority portion of the bridge id'),
    ],
    run: () => NOTHING,
  }),
  switchCommand({
    modes: GLOBAL,
    path: [
      spanningTree,
      vlanKw,
      vlans,
      keyword('priority', 'Set the bridge priority for the spanning tree'),
      num('priority', 0, 61440, 'bridge priority in increments of 4096'),
    ],
    run: ({ vlans: ranges, priority }, ctx) => {
      const parsed = BridgePriority.safeParse(priority);
      if (!parsed.success) return ctx.reject('% Bridge Priority must be in increments of 4096.');
      return setPriority(ctx, ranges, parsed.data);
    },
    no: ({ vlans: ranges }, ctx) =>
      ranges ? setPriority(ctx, ranges, DEFAULT_BRIDGE_PRIORITY) : ctx.reject(INVALID_INPUT),
  }),
  switchCommand({
    modes: GLOBAL,
    path: [
      spanningTree,
      vlanKw,
      vlans,
      keyword('root', 'Configure switch as root'),
      choice('role', {
        primary: 'Configure this switch as primary root for this spanning tree',
        secondary: 'Configure switch as secondary root',
      }),
    ],
    run: ({ vlans: ranges, role }, ctx) => setPriority(ctx, ranges, ROOT_PRIORITY[role]),
    no: ({ vlans: ranges }, ctx) =>
      ranges ? setPriority(ctx, ranges, DEFAULT_BRIDGE_PRIORITY) : ctx.reject(INVALID_INPUT),
  }),
  switchCommand({
    modes: IF,
    path: [
      spanningTree,
      keyword('portfast', 'Enable an interface to move directly to forwarding on link up'),
    ],
    run: (_a, ctx, mode) => {
      const ports = switchportsOf(ctx, mode);
      if (!ports) return ctx.reject(INVALID_INPUT);
      for (const [, port] of ports) port.portfast = true;
      return [...PORTFAST_WARNING, ...ports.flatMap(([id]) => portfastNote(id))];
    },
    no: (_a, ctx, mode) =>
      eachSwitchport(ctx, mode, (port) => {
        delete port.portfast;
      }),
  }),
  switchCommand({
    modes: IF,
    path: [
      spanningTree,
      keyword('cost', "Change an interface's spanning tree port path cost"),
      num('cost', 1, 200_000_000, 'port path cost'),
    ],
    run: ({ cost }, ctx, mode) =>
      eachSwitchport(ctx, mode, (port) => {
        port.stpCost = PathCost.parse(cost);
      }),
    no: (_a, ctx, mode) =>
      eachSwitchport(ctx, mode, (port) => {
        delete port.stpCost;
      }),
  }),
];
