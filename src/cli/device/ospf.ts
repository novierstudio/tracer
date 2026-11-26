import type { Draft } from 'immer';
import {
  ipv4ToUint32,
  uint32ToIpv4,
  type Ipv4Address,
  type OspfConfig,
  type RoutedInterface,
  type Subinterface,
} from '../../model';
import type { ModeOf } from '../modes';
import { iface, ipv4, keyword, num } from '../params';
import { defineCommand } from '../tree';
import { INVALID_INPUT, type RouterContext } from './context';
import { findInterface, interfaceEntries, isLayer2 } from './show';
import { showIpOspfInterface, showIpOspfInterfaceBrief, showIpOspfNeighbor } from './showOspf';

const routerCommand = defineCommand<RouterContext>();

const EXEC = ['user-exec', 'priv-exec'] as const;
const GLOBAL = ['global-config'] as const;
const OSPF = ['ospf-config'] as const;
const ANY_IF = ['interface-config', 'subinterface-config'] as const;

const NOTHING: readonly string[] = [];
const INCOMPLETE = '% Incomplete command.';

const show = keyword('show', 'Show running system information');
const showIp = keyword('ip', 'IP information');
const showOspf = keyword('ospf', 'OSPF information');
const showInterface = keyword('interface', 'Interface information');
const interfaceIp = keyword('ip', 'Interface Internet Protocol config commands');
const interfaceOspf = keyword('ospf', 'OSPF interface commands');
const routerId = keyword('router-id', 'router-id for this OSPF process');
const passiveInterface = keyword('passive-interface', 'Suppress routing updates on an interface');
const networkPath = [
  keyword('network', 'Enable routing on an IP network'),
  ipv4('address', 'Network number'),
  ipv4('wildcard', 'OSPF wild card bits'),
  keyword('area', 'Set the OSPF area ID'),
  num('area', 0, 4294967295, 'OSPF area ID as a decimal value'),
] as const;

/** The router's OSPF process. `router ospf` creates it, so it is there in `ospf-config` unless undone. */
function ospfOf(ctx: RouterContext, mode: ModeOf<'ospf-config'>): Draft<OspfConfig> {
  return (ctx.device.config.ospf ??= {
    processId: mode.processId,
    networks: [],
    passiveInterfaces: [],
  });
}

/** IOS keeps a network's address with its wildcard bits cleared, as it matches interfaces. */
function networkNumber(address: Ipv4Address, wildcard: Ipv4Address): Ipv4Address {
  return uint32ToIpv4((ipv4ToUint32(address) & ~ipv4ToUint32(wildcard)) >>> 0);
}

/** Applies `edit` to each routed interface or subinterface of the mode. */
export function eachInterface(
  ctx: RouterContext,
  mode: ModeOf<'interface-config' | 'subinterface-config'>,
  edit: (config: Draft<RoutedInterface> | Draft<Subinterface>) => void,
): readonly string[] {
  const ids = mode.kind === 'interface-config' ? mode.interfaces : [mode.interface];
  for (const id of ids) {
    const target = findInterface(ctx.device, id);
    if (!target || isLayer2(target)) return ctx.reject(INVALID_INPUT);
    edit(target.config);
  }
  return NOTHING;
}

export const ospfCommands = [
  routerCommand({
    modes: EXEC,
    path: [show, showIp, showOspf, keyword('neighbor', 'Neighbor list')],
    run: (_a, ctx) => ctx.query('protocols', showIpOspfNeighbor),
  }),
  routerCommand({
    modes: EXEC,
    path: [show, showIp, showOspf, showInterface],
    run: (_a, ctx) => ctx.query('protocols', showIpOspfInterface),
  }),
  routerCommand({
    modes: EXEC,
    path: [show, showIp, showOspf, showInterface, iface('name', 'Interface name')],
    run: ({ name }, ctx) => {
      if (!findInterface(ctx.device, name)) return ctx.reject(INVALID_INPUT);
      return ctx.query('protocols', (answer, device) => showIpOspfInterface(answer, device, name));
    },
  }),
  routerCommand({
    modes: EXEC,
    path: [
      show,
      showIp,
      showOspf,
      showInterface,
      keyword('brief', 'Brief summary of OSPF interface information'),
    ],
    run: (_a, ctx) => ctx.query('protocols', showIpOspfInterfaceBrief),
  }),
  routerCommand({
    modes: GLOBAL,
    path: [
      keyword('router', 'Enable a routing process'),
      keyword('ospf', 'Open Shortest Path First (OSPF)'),
      num('processId', 1, 65535, 'Process ID'),
    ],
    to: ({ processId }) => ({ kind: 'ospf-config', processId }),
    run: ({ processId }, ctx) => {
      const { config } = ctx.device;
      if (config.ospf && config.ospf.processId !== processId) {
        return ctx.reject(
          `% Tracer runs one OSPF process per router. Remove router ospf ${config.ospf.processId} first.`,
        );
      }
      config.ospf ??= { processId, networks: [], passiveInterfaces: [] };
      return NOTHING;
    },
    no: ({ processId }, ctx) => {
      if (processId === undefined) return ctx.reject(INCOMPLETE);
      if (ctx.device.config.ospf?.processId === processId) delete ctx.device.config.ospf;
      return NOTHING;
    },
  }),
  routerCommand({
    modes: OSPF,
    path: [routerId, ipv4('id', 'OSPF router-id in IP address format')],
    run: ({ id }, ctx, mode) => {
      ospfOf(ctx, mode).routerId = id;
      return NOTHING;
    },
    no: (_a, ctx, mode) => {
      delete ospfOf(ctx, mode).routerId;
      return NOTHING;
    },
  }),
  routerCommand({
    modes: OSPF,
    path: networkPath,
    run: ({ address, wildcard, area }, ctx, mode) => {
      const ospf = ospfOf(ctx, mode);
      const entry = { address: networkNumber(address, wildcard), wildcard, area };
      const same = ospf.networks.findIndex(
        (n) => n.address === entry.address && n.wildcard === wildcard,
      );
      if (same === -1) ospf.networks.push(entry);
      else ospf.networks[same] = entry;
      return NOTHING;
    },
    no: ({ address, wildcard, area }, ctx, mode) => {
      if (address === undefined || wildcard === undefined || area === undefined) {
        return ctx.reject(INCOMPLETE);
      }
      const ospf = ospfOf(ctx, mode);
      const number = networkNumber(address, wildcard);
      ospf.networks = ospf.networks.filter(
        (n) => !(n.address === number && n.wildcard === wildcard && n.area === area),
      );
      return NOTHING;
    },
  }),
  routerCommand({
    modes: OSPF,
    path: [passiveInterface, iface('name', 'Interface name')],
    run: ({ name }, ctx, mode) => {
      if (!findInterface(ctx.device, name)) return ctx.reject(INVALID_INPUT);
      const ospf = ospfOf(ctx, mode);
      const passive = new Set([...ospf.passiveInterfaces, name]);
      ospf.passiveInterfaces = interfaceEntries(ctx.device)
        .map((entry) => entry.id)
        .filter((id) => passive.has(id));
      return NOTHING;
    },
    no: ({ name }, ctx, mode) => {
      if (name === undefined) return ctx.reject(INCOMPLETE);
      if (!findInterface(ctx.device, name)) return ctx.reject(INVALID_INPUT);
      const ospf = ospfOf(ctx, mode);
      ospf.passiveInterfaces = ospf.passiveInterfaces.filter((id) => id !== name);
      return NOTHING;
    },
  }),
  routerCommand({
    modes: ANY_IF,
    path: [
      interfaceIp,
      interfaceOspf,
      keyword('cost', 'Interface cost'),
      num('cost', 1, 65535, 'Cost'),
    ],
    run: ({ cost }, ctx, mode) =>
      eachInterface(ctx, mode, (config) => void (config.ospfCost = cost)),
    no: (_a, ctx, mode) => eachInterface(ctx, mode, (config) => void delete config.ospfCost),
  }),
  routerCommand({
    modes: ANY_IF,
    path: [
      interfaceIp,
      interfaceOspf,
      keyword('priority', 'Router priority'),
      num('priority', 0, 255, 'Priority'),
    ],
    run: ({ priority }, ctx, mode) =>
      eachInterface(ctx, mode, (config) => void (config.ospfPriority = priority)),
    no: (_a, ctx, mode) => eachInterface(ctx, mode, (config) => void delete config.ospfPriority),
  }),
];
