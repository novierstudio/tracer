import type { Draft } from 'immer';
import {
  ipv4ToUint32,
  uint32ToIpv4,
  type Ipv4Address,
  type OspfArea,
  type OspfConfig,
  type PrefixLength,
  type RoutedInterface,
  type Subinterface,
} from '../../model';
import type { ModeOf } from '../modes';
import { choice, iface, ipv4, keyword, mask, num, type Segment } from '../params';
import { defineCommand, type Command } from '../tree';
import { INVALID_INPUT, type DeviceContext } from './context';
import { findInterface, interfaceEntries, isLayer2 } from './show';
import {
  showIpOspf,
  showIpOspfBorderRouters,
  showIpOspfDatabase,
  showIpOspfInterface,
  showIpOspfInterfaceBrief,
  showIpOspfNeighbor,
} from './showOspf';

const routerCommand = defineCommand<DeviceContext>();

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
function ospfOf(ctx: DeviceContext, mode: ModeOf<'ospf-config'>): Draft<OspfConfig> {
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
  ctx: DeviceContext,
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

const CLASSFUL_ONLY = '% Only classful networks will be redistributed';
const BACKBONE_STUB = '% OSPF: Backbone can not be configured as stub area';

const areaPath = [
  keyword('area', 'OSPF area parameters'),
  num('area', 0, 4294967295, 'OSPF area ID as a decimal value'),
] as const;

/** The wildcard bits of a prefix length, as `network` takes them. */
const wildcardOf = (prefixLength: PrefixLength): Ipv4Address =>
  uint32ToIpv4((2 ** (32 - prefixLength) - 1) >>> 0);

/** The area's `area` settings, created empty when absent. */
function areaOf(ospf: Draft<OspfConfig>, area: number): Draft<OspfArea> {
  const areas = (ospf.areas ??= []);
  let entry = areas.find((candidate) => candidate.area === area);
  if (!entry) areas.push((entry = { area }));
  return entry;
}

/** Drops areas left with no settings, and the list once it is empty. */
function pruneAreas(ospf: Draft<OspfConfig>) {
  const kept = ospf.areas?.filter((entry) => entry.stub !== undefined || entry.ranges?.length);
  if (kept?.length) ospf.areas = kept;
  else delete ospf.areas;
}

/** Every order of every subset of `items`, as IOS takes optional keywords in any order. */
function orderings<T>(items: readonly T[]): T[][] {
  const out: T[][] = [[]];
  const grow = (prefix: T[], rest: readonly T[]) => {
    rest.forEach((item, i) => {
      const next = [...prefix, item];
      out.push(next);
      grow(next, [...rest.slice(0, i), ...rest.slice(i + 1)]);
    });
  };
  grow([], items);
  return out;
}

type MetricArgs = { readonly metric?: number; readonly metricType?: '1' | '2' };

const metricTypeOf = (args: MetricArgs) =>
  args.metricType === undefined ? undefined : (Number(args.metricType) as 1 | 2);

const METRIC_TYPES = {
  1: 'Set OSPF External Type 1 metrics',
  2: 'Set OSPF External Type 2 metrics',
} as const;

/**
 * `redistribute connected|static [metric <n>] [metric-type 1|2] [subnets]`, the options in any
 * order. A repeat changes only the options it names. Without `subnets` IOS warns that only
 * classful networks go out.
 */
function redistributeCommands(): Command<DeviceContext>[] {
  const options = {
    metric: [
      keyword('metric', 'Metric for redistributed routes'),
      num('metric', 0, 16777214, 'OSPF default metric'),
    ],
    'metric-type': [
      keyword('metric-type', 'OSPF/IS-IS exterior metric type for redistributed routes'),
      choice('metricType', METRIC_TYPES),
    ],
    subnets: [keyword('subnets', 'Consider subnets for redistribution into OSPF')],
  } satisfies Record<string, readonly Segment[]>;
  const redistribute = keyword(
    'redistribute',
    'Redistribute information from another routing protocol',
  );
  const sources = [
    ['connected', 'Connected', 'redistributeConnected'],
    ['static', 'Static routes', 'redistributeStatic'],
  ] as const;
  return sources.flatMap(([source, help, field]) =>
    orderings(Object.keys(options) as (keyof typeof options)[]).map((order) =>
      routerCommand({
        modes: OSPF,
        path: [
          redistribute,
          keyword(source, help),
          ...order.flatMap((option): readonly Segment[] => options[option]),
        ],
        run: (args, ctx, mode) => {
          const ospf = ospfOf(ctx, mode);
          const { metric } = args as MetricArgs;
          const metricType = metricTypeOf(args as MetricArgs);
          const held = ospf[field];
          const next = {
            ...held,
            ...(metric === undefined ? {} : { metric }),
            ...(metricType === undefined ? {} : { metricType }),
            subnets: (held?.subnets ?? false) || order.includes('subnets'),
          };
          ospf[field] = next;
          return next.subnets ? NOTHING : [CLASSFUL_ONLY];
        },
        no: (_a, ctx, mode) => {
          delete ospfOf(ctx, mode)[field];
          return NOTHING;
        },
      }),
    ),
  );
}

/** `default-information originate [always] [metric <n>] [metric-type 1|2]`, in any order. */
function defaultInformationCommands(): Command<DeviceContext>[] {
  const options = {
    always: [keyword('always', 'Always advertise default route')],
    metric: [keyword('metric', 'OSPF default metric'), num('metric', 0, 16777214, 'OSPF metric')],
    'metric-type': [
      keyword('metric-type', 'OSPF metric type for default routes'),
      choice('metricType', METRIC_TYPES),
    ],
  } satisfies Record<string, readonly Segment[]>;
  const base = [
    keyword('default-information', 'Control distribution of default information'),
    keyword('originate', 'Distribute a default route'),
  ];
  return orderings(Object.keys(options) as (keyof typeof options)[]).map((order) =>
    routerCommand({
      modes: OSPF,
      path: [...base, ...order.flatMap((option): readonly Segment[] => options[option])],
      run: (args, ctx, mode) => {
        const { metric } = args as MetricArgs;
        const metricType = metricTypeOf(args as MetricArgs);
        ospfOf(ctx, mode).defaultOriginate = {
          always: order.includes('always'),
          ...(metric === undefined ? {} : { metric }),
          ...(metricType === undefined ? {} : { metricType }),
        };
        return NOTHING;
      },
      no: (_a, ctx, mode) => {
        delete ospfOf(ctx, mode).defaultOriginate;
        return NOTHING;
      },
    }),
  );
}

type RangeArgs = {
  readonly area: number;
  readonly address: Ipv4Address;
  readonly mask: PrefixLength;
};

/** `area <id> range <address> <mask> [advertise|not-advertise]` and `area <id> stub [no-summary]`. */
function areaCommands(): Command<DeviceContext>[] {
  const rangePath = [
    ...areaPath,
    keyword('range', 'Summarize routes matching address/mask (border routers only)'),
    ipv4('address', 'IP address to match'),
    mask('mask', 'IP mask for address'),
  ] as const;
  const prefixOf = ({ address, mask: prefixLength }: RangeArgs) => ({
    address: networkNumber(address, wildcardOf(prefixLength)),
    prefixLength,
  });
  const setRange = (
    args: RangeArgs,
    ctx: DeviceContext,
    mode: ModeOf<'ospf-config'>,
    advertise: boolean,
  ) => {
    const prefix = prefixOf(args);
    const ranges = (areaOf(ospfOf(ctx, mode), args.area).ranges ??= []);
    const held = ranges.find(
      (range) =>
        range.prefix.address === prefix.address &&
        range.prefix.prefixLength === prefix.prefixLength,
    );
    if (held) held.advertise = advertise;
    else ranges.push({ prefix, advertise });
    return NOTHING;
  };
  const removeRange = (
    args: Partial<RangeArgs>,
    ctx: DeviceContext,
    mode: ModeOf<'ospf-config'>,
  ) => {
    if (args.area === undefined || args.address === undefined || args.mask === undefined)
      return ctx.reject(INCOMPLETE);
    const prefix = prefixOf(args as RangeArgs);
    const ospf = ospfOf(ctx, mode);
    const entry = ospf.areas?.find((candidate) => candidate.area === args.area);
    if (entry?.ranges) {
      entry.ranges = entry.ranges.filter(
        (range) =>
          range.prefix.address !== prefix.address ||
          range.prefix.prefixLength !== prefix.prefixLength,
      );
    }
    pruneAreas(ospf);
    return NOTHING;
  };
  const stubPath = [...areaPath, keyword('stub', 'Specify a stub area')] as const;
  const setStub = (
    area: number,
    ctx: DeviceContext,
    mode: ModeOf<'ospf-config'>,
    stub: NonNullable<OspfArea['stub']>,
  ) => {
    if (area === 0) return ctx.reject(BACKBONE_STUB);
    areaOf(ospfOf(ctx, mode), area).stub = stub;
    return NOTHING;
  };
  return [
    routerCommand({
      modes: OSPF,
      path: rangePath,
      run: (args, ctx, mode) => setRange(args, ctx, mode, true),
      no: removeRange,
    }),
    routerCommand({
      modes: OSPF,
      path: [...rangePath, keyword('advertise', 'Advertise this range (default)')],
      run: (args, ctx, mode) => setRange(args, ctx, mode, true),
      no: removeRange,
    }),
    routerCommand({
      modes: OSPF,
      path: [...rangePath, keyword('not-advertise', 'DoNotAdvertise this range')],
      run: (args, ctx, mode) => setRange(args, ctx, mode, false),
      no: removeRange,
    }),
    routerCommand({
      modes: OSPF,
      path: stubPath,
      run: ({ area }, ctx, mode) => setStub(area, ctx, mode, 'stub'),
      no: ({ area }, ctx, mode) => {
        if (area === undefined) return ctx.reject(INCOMPLETE);
        const ospf = ospfOf(ctx, mode);
        const entry = ospf.areas?.find((candidate) => candidate.area === area);
        if (entry) delete entry.stub;
        pruneAreas(ospf);
        return NOTHING;
      },
    }),
    routerCommand({
      modes: OSPF,
      path: [...stubPath, keyword('no-summary', 'Do not send summary LSA into stub area')],
      run: ({ area }, ctx, mode) => setStub(area, ctx, mode, 'no-summary'),
      // `no area <id> stub no-summary` keeps the stub area and lets summaries in again.
      no: ({ area }, ctx, mode) => {
        if (area === undefined) return ctx.reject(INCOMPLETE);
        const entry = ospfOf(ctx, mode).areas?.find((candidate) => candidate.area === area);
        if (entry?.stub) entry.stub = 'stub';
        return NOTHING;
      },
    }),
  ];
}

export const ospfCommands = [
  routerCommand({
    modes: EXEC,
    path: [show, showIp, showOspf],
    run: (_a, ctx) => ctx.query('protocols', showIpOspf),
  }),
  routerCommand({
    modes: EXEC,
    path: [show, showIp, showOspf, keyword('database', 'Database summary')],
    run: (_a, ctx) => ctx.query('protocols', showIpOspfDatabase),
  }),
  routerCommand({
    modes: EXEC,
    path: [
      show,
      showIp,
      showOspf,
      keyword('border-routers', 'Border and Boundary Router Information'),
    ],
    run: (_a, ctx) => ctx.query('protocols', showIpOspfBorderRouters),
  }),
  ...areaCommands(),
  ...redistributeCommands(),
  ...defaultInformationCommands(),
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
