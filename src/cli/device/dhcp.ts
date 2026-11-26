import type { Draft } from 'immer';
import {
  DEFAULT_DHCP_LEASE,
  DhcpLease,
  ipv4ToUint32,
  MAX_DHCP_OPTION_ADDRESSES,
  prefixMask,
  uint32ToIpv4,
  type DhcpPool,
  type DhcpServerConfig,
  type Ipv4Address,
} from '../../model';
import type { ModeOf } from '../modes';
import { ipv4, keyword, mask, num, word, type Param } from '../params';
import { defineCommand } from '../tree';
import { INVALID_INPUT, type RouterContext } from './context';
import { showIpDhcpBinding, showIpDhcpPool } from './showDhcp';

const routerCommand = defineCommand<RouterContext>();

const GLOBAL = ['global-config'] as const;
const DHCP = ['dhcp-config'] as const;
const EXEC = ['user-exec', 'priv-exec'] as const;

type PoolMode = ModeOf<'dhcp-config'>;

const NOTHING: readonly string[] = [];

const globalIp = keyword('ip', 'Global IP configuration subcommands');
const dhcpKw = keyword('dhcp', 'Configure DHCP server and relay parameters');

/** The router's DHCP server config, created by its first command. */
function serverOf(ctx: RouterContext): Draft<DhcpServerConfig> {
  return (ctx.device.config.dhcp ??= { pools: {}, excluded: [] });
}

/** Drops the DHCP server config once nothing is left in it, so it stays out of the file. */
function tidy(ctx: RouterContext) {
  const { dhcp } = ctx.device.config;
  if (dhcp && dhcp.excluded.length === 0 && Object.keys(dhcp.pools).length === 0) {
    delete ctx.device.config.dhcp;
  }
}

/** Edits the pool the mode is in. Refused when the pool is gone, as a GUI edit can make it. */
function editPool(ctx: RouterContext, mode: PoolMode, edit: (pool: Draft<DhcpPool>) => void) {
  const pool = ctx.device.config.dhcp?.pools[mode.pool];
  if (!pool) return ctx.reject(INVALID_INPUT);
  edit(pool);
  return NOTHING;
}

function excludedCommands() {
  const path = [
    globalIp,
    dhcpKw,
    keyword('excluded-address', 'Prevent DHCP from assigning certain addresses'),
    ipv4('low', 'Low IP address'),
  ] as const;
  const high = ipv4('high', 'High IP address');
  const sameRange =
    (first: Ipv4Address, last: Ipv4Address) => (range: DhcpServerConfig['excluded'][number]) =>
      range.first === first && range.last === last;
  const add = (ctx: RouterContext, first: Ipv4Address, last: Ipv4Address) => {
    if (ipv4ToUint32(first) > ipv4ToUint32(last)) return ctx.reject('% Invalid address range');
    const server = serverOf(ctx);
    if (!server.excluded.some(sameRange(first, last))) server.excluded.push({ first, last });
    return NOTHING;
  };
  const remove = (args: { low?: Ipv4Address; high?: Ipv4Address }, ctx: RouterContext) => {
    const { low, high: last = low } = args;
    if (low === undefined || last === undefined) return ctx.reject('% Incomplete command.');
    const server = ctx.device.config.dhcp;
    if (server) server.excluded = server.excluded.filter((range) => !sameRange(low, last)(range));
    tidy(ctx);
    return NOTHING;
  };
  return [
    routerCommand({
      modes: GLOBAL,
      path,
      run: ({ low }, ctx) => add(ctx, low, low),
      no: remove,
    }),
    routerCommand({
      modes: GLOBAL,
      path: [...path, high],
      run: ({ low, high: last }, ctx) => add(ctx, low, last),
      no: remove,
    }),
  ];
}

/**
 * `default-router` or `dns-server` with one to eight addresses, as IOS takes them. Each length is
 * its own command, so `?` offers the next address after every one.
 */
function addressListCommands(
  word: string,
  help: string,
  addressHelp: string,
  field: 'defaultRouters' | 'dnsServers',
) {
  const params: Param<string, Ipv4Address>[] = Array.from(
    { length: MAX_DHCP_OPTION_ADDRESSES },
    (_, n) => ipv4(`address${n + 1}`, addressHelp),
  );
  const listKw = keyword(word, help);
  return params.map((_, n) =>
    routerCommand({
      modes: DHCP,
      path: [listKw, ...params.slice(0, n + 1)],
      run: (args, ctx, mode) => {
        const named = args as Readonly<Record<string, Ipv4Address>>;
        const addresses = params.slice(0, n + 1).map((param) => named[param.name]!);
        return editPool(ctx, mode, (pool) => void (pool[field] = addresses));
      },
      no: (_a, ctx, mode) => editPool(ctx, mode, (pool) => void delete pool[field]),
    }),
  );
}

/** `lease {days [hours [minutes]] | infinite}`. The default, one day, is stored as no lease. */
function leaseCommands() {
  const leaseKw = keyword('lease', 'Address lease time');
  const days = num('days', 0, 365, 'Days');
  const hours = num('hours', 0, 23, 'Hours');
  const minutes = num('minutes', 0, 59, 'Minutes');
  const set = (ctx: RouterContext, mode: PoolMode, lease: number | 'infinite') => {
    const parsed = DhcpLease.safeParse(lease);
    if (!parsed.success) return ctx.reject('% A lease must last at least 1 minute');
    return editPool(ctx, mode, (pool) => {
      if (parsed.data === DEFAULT_DHCP_LEASE) delete pool.lease;
      else pool.lease = parsed.data;
    });
  };
  const reset = (_a: unknown, ctx: RouterContext, mode: PoolMode) =>
    editPool(ctx, mode, (pool) => void delete pool.lease);
  const minutesOf = (d: number, h = 0, m = 0) => d * 1440 + h * 60 + m;
  return [
    routerCommand({
      modes: DHCP,
      path: [leaseKw, keyword('infinite', 'Infinite lease')],
      run: (_a, ctx, mode) => set(ctx, mode, 'infinite'),
      no: reset,
    }),
    routerCommand({
      modes: DHCP,
      path: [leaseKw, days],
      run: (a, ctx, mode) => set(ctx, mode, minutesOf(a.days)),
      no: reset,
    }),
    routerCommand({
      modes: DHCP,
      path: [leaseKw, days, hours],
      run: (a, ctx, mode) => set(ctx, mode, minutesOf(a.days, a.hours)),
      no: reset,
    }),
    routerCommand({
      modes: DHCP,
      path: [leaseKw, days, hours, minutes],
      run: (a, ctx, mode) => set(ctx, mode, minutesOf(a.days, a.hours, a.minutes)),
      no: reset,
    }),
  ];
}

function showCommands() {
  const path = [
    keyword('show', 'Show running system information'),
    keyword('ip', 'IP information'),
    keyword('dhcp', 'Show items in the DHCP database'),
  ] as const;
  const pool = keyword('pool', 'DHCP pools information');
  return [
    routerCommand({
      modes: EXEC,
      path: [...path, keyword('binding', 'DHCP address bindings')],
      run: (_a, ctx) => ctx.query('dhcpBindings', showIpDhcpBinding),
    }),
    routerCommand({
      modes: EXEC,
      path: [...path, pool],
      run: (_a, ctx) =>
        ctx.query('dhcpBindings', (bindings, device) => showIpDhcpPool(bindings, device) ?? []),
    }),
    routerCommand({
      modes: EXEC,
      path: [...path, pool, word('name', 'Pool name')],
      run: ({ name }, ctx) =>
        showIpDhcpPool(undefined, ctx.device, name) === undefined
          ? ctx.reject(`%Pool ${name} is not found`)
          : ctx.query(
              'dhcpBindings',
              (bindings, device) => showIpDhcpPool(bindings, device, name) ?? [],
            ),
    }),
  ];
}

/** The commands of a router's DHCP server: config in global config and in a pool, and show. */
export const dhcpCommands = [
  ...showCommands(),
  routerCommand({
    modes: GLOBAL,
    path: [
      globalIp,
      dhcpKw,
      keyword('pool', 'Configure DHCP address pools'),
      word('name', 'Pool name'),
    ],
    to: ({ name }) => ({ kind: 'dhcp-config', pool: name }),
    run: ({ name }, ctx) => {
      serverOf(ctx).pools[name] ??= {};
      return NOTHING;
    },
    no: ({ name }, ctx) => {
      if (name === undefined) return ctx.reject('% Incomplete command.');
      const pools = ctx.device.config.dhcp?.pools;
      if (!pools || !(name in pools)) return ctx.reject(`%Pool ${name} does not exist`);
      delete pools[name];
      tidy(ctx);
      return NOTHING;
    },
  }),
  ...excludedCommands(),
  routerCommand({
    modes: DHCP,
    path: [
      keyword('network', 'Network number and mask'),
      ipv4('network', 'Network number in dotted-decimal notation'),
      mask('mask', 'Network mask or prefix length'),
    ],
    // A host address names its subnet, so the pool keeps the network number.
    run: ({ network, mask: prefixLength }, ctx, mode) => {
      const address = uint32ToIpv4((ipv4ToUint32(network) & prefixMask(prefixLength)) >>> 0);
      return editPool(ctx, mode, (pool) => void (pool.network = { address, prefixLength }));
    },
    no: (_a, ctx, mode) => editPool(ctx, mode, (pool) => void delete pool.network),
  }),
  ...addressListCommands(
    'default-router',
    'Default routers',
    "Router's IP address",
    'defaultRouters',
  ),
  ...addressListCommands('dns-server', 'DNS servers', "Server's IP address", 'dnsServers'),
  ...leaseCommands(),
];
