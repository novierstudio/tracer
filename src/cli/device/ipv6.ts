import type { Draft } from 'immer';
import type { InterfaceId, Ipv6InterfaceConfig, Ipv6StaticRoute } from '../../model';
import {
  ipv6Enabled,
  ipv6Network,
  isLinkLocal,
  type Ipv6Address,
  type Ipv6Cidr,
} from '../../model/ipv6';
import type { ModeOf } from '../modes';
import { iface, ipv6, ipv6Prefix, keyword, num } from '../params';
import { defineCommand } from '../tree';
import { eachRoutedInterface } from './acl';
import { INVALID_INPUT, type RouterContext } from './context';
import { pingCommands, tracerouteCommand } from './exec';
import { findInterface } from './show';
import {
  showIpv6Interface,
  showIpv6InterfaceBrief,
  showIpv6Neighbors,
  showIpv6Route,
} from './showIpv6';

const routerCommand = defineCommand<RouterContext>();

const EXEC = ['user-exec', 'priv-exec'] as const;
const GLOBAL = ['global-config'] as const;
const ANY_IF = ['interface-config', 'subinterface-config'] as const;

const NOTHING: readonly string[] = [];

type InterfaceMode = ModeOf<(typeof ANY_IF)[number]>;

const sameCidr = (a: Ipv6Cidr, b: Ipv6Cidr) =>
  a.address === b.address && a.prefixLength === b.prefixLength;

/** The prefix with its host bits cleared, as IOS keeps a route's or an EUI-64 address's. */
const networkOf = (cidr: Ipv6Cidr): Ipv6Cidr => ({
  address: ipv6Network(cidr),
  prefixLength: cidr.prefixLength,
});

/**
 * Applies `change` to the IPv6 settings of each interface of the mode, and drops the settings once
 * nothing in them keeps IPv6 on.
 */
function editIpv6(
  ctx: RouterContext,
  mode: InterfaceMode,
  change: (config: Draft<Ipv6InterfaceConfig>) => void,
): readonly string[] {
  return eachRoutedInterface(ctx, mode, (target) => {
    const config = (target.ipv6 ??= { addresses: [] });
    change(config);
    if (!ipv6Enabled(config)) delete target.ipv6;
  });
}

/** Adds an `ipv6 address` line, unless the interface has it already. */
function addAddress(ctx: RouterContext, mode: InterfaceMode, cidr: Ipv6Cidr, eui64: boolean) {
  return editIpv6(ctx, mode, (config) => {
    const known = config.addresses.some((a) => a.eui64 === eui64 && sameCidr(a.cidr, cidr));
    if (!known) config.addresses.push({ cidr, eui64 });
  });
}

function removeAddress(ctx: RouterContext, mode: InterfaceMode, cidr: Ipv6Cidr, eui64: boolean) {
  return editIpv6(ctx, mode, (config) => {
    config.addresses = config.addresses.filter((a) => a.eui64 !== eui64 || !sameCidr(a.cidr, cidr));
  });
}

function interfaceCommands() {
  const ipv6Kw = keyword('ipv6', 'IPv6 interface subcommands');
  const address = keyword('address', 'Configure IPv6 address on interface');
  const prefix = ipv6Prefix('prefix', 'IPv6 prefix');
  const linkLocal = ipv6('linkLocal', 'IPv6 link-local address');
  return [
    routerCommand({
      modes: ANY_IF,
      path: [ipv6Kw, address, prefix],
      run: (a, ctx, mode) => addAddress(ctx, mode, a.prefix, false),
      // `no ipv6 address` with no address takes every address away, the link-local one too.
      no: (a, ctx, mode) =>
        a.prefix === undefined
          ? editIpv6(ctx, mode, (config) => {
              config.addresses = [];
              delete config.linkLocal;
            })
          : removeAddress(ctx, mode, a.prefix, false),
    }),
    routerCommand({
      modes: ANY_IF,
      path: [ipv6Kw, address, prefix, keyword('eui-64', 'Use eui-64 interface identifier')],
      run: (a, ctx, mode) => addAddress(ctx, mode, networkOf(a.prefix), true),
      no: (a, ctx, mode) =>
        a.prefix === undefined ? NOTHING : removeAddress(ctx, mode, networkOf(a.prefix), true),
    }),
    routerCommand({
      modes: ANY_IF,
      path: [ipv6Kw, address, linkLocal, keyword('link-local', 'Use link-local address')],
      run: (a, ctx, mode) =>
        isLinkLocal(a.linkLocal)
          ? editIpv6(ctx, mode, (config) => void (config.linkLocal = a.linkLocal))
          : ctx.reject('% Invalid link-local address'),
      no: (_a, ctx, mode) => editIpv6(ctx, mode, (config) => void delete config.linkLocal),
    }),
    routerCommand({
      modes: ANY_IF,
      path: [ipv6Kw, address, keyword('autoconfig', 'Obtain address using autoconfiguration')],
      run: (_a, ctx, mode) => editIpv6(ctx, mode, (config) => void (config.autoconfig = true)),
      no: (_a, ctx, mode) => editIpv6(ctx, mode, (config) => void delete config.autoconfig),
    }),
    routerCommand({
      modes: ANY_IF,
      path: [ipv6Kw, keyword('enable', 'Enable IPv6 on interface')],
      run: (_a, ctx, mode) => editIpv6(ctx, mode, (config) => void (config.enabled = true)),
      no: (_a, ctx, mode) => editIpv6(ctx, mode, (config) => void delete config.enabled),
    }),
  ];
}

const LINK_LOCAL_NEEDS_INTERFACE = '% Interface has to be specified for a link-local nexthop';

/** Adds a static route, or replaces the one with the same prefix and next hop. */
function setRoute(
  ctx: RouterContext,
  prefix: Ipv6Cidr,
  nextHop: Ipv6StaticRoute['nextHop'],
  distance: number | undefined,
) {
  if (nextHop.kind === 'address' && !nextHop.interface && isLinkLocal(nextHop.address)) {
    return ctx.reject(LINK_LOCAL_NEEDS_INTERFACE);
  }
  if (nextHop.interface && !findInterface(ctx.device, nextHop.interface)) {
    return ctx.reject(INVALID_INPUT);
  }
  const route: Ipv6StaticRoute = {
    prefix: networkOf(prefix),
    nextHop,
    ...(distance === undefined || distance === 1 ? {} : { distance }),
  };
  const routes = (ctx.device.config.ipv6StaticRoutes ??= []);
  const same = routes.findIndex(
    (r) =>
      sameCidr(r.prefix, route.prefix) && JSON.stringify(r.nextHop) === JSON.stringify(nextHop),
  );
  if (same === -1) routes.push(route);
  else routes[same] = route;
  return NOTHING;
}

interface RouteArgs {
  readonly prefix?: Ipv6Cidr;
  readonly exit?: InterfaceId;
  readonly nextHop?: Ipv6Address;
}

/** `no ipv6 route`: the routes to the prefix, narrowed by the interface and next hop given. */
function removeRoutes(ctx: RouterContext, { prefix, exit, nextHop }: RouteArgs) {
  if (prefix === undefined) return ctx.reject('% Incomplete command.');
  const network = networkOf(prefix);
  const routes = ctx.device.config.ipv6StaticRoutes ?? [];
  const keep = routes.filter(
    ({ prefix: kept, nextHop: hop }) =>
      !sameCidr(kept, network) ||
      (exit !== undefined && hop.interface !== exit) ||
      (nextHop !== undefined && !(hop.kind === 'address' && hop.address === nextHop)),
  );
  if (keep.length > 0) ctx.device.config.ipv6StaticRoutes = keep;
  else delete ctx.device.config.ipv6StaticRoutes;
  return NOTHING;
}

function globalCommands() {
  const ipv6Kw = keyword('ipv6', 'Global IPv6 configuration commands');
  const route = [
    ipv6Kw,
    keyword('route', 'Configure static routes'),
    ipv6Prefix('prefix', 'IPv6 prefix'),
  ] as const;
  const nextHop = ipv6('nextHop', 'IPv6 address of next-hop');
  const exit = iface('exit', 'Interface');
  const distance = num('distance', 1, 254, 'Administrative distance');
  const no = (a: RouteArgs, ctx: RouterContext) => removeRoutes(ctx, a);
  const viaAddress = (a: { nextHop: Ipv6Address; exit?: InterfaceId }) =>
    ({
      kind: 'address',
      address: a.nextHop,
      ...(a.exit === undefined ? {} : { interface: a.exit }),
    }) as const;
  const viaInterface = (a: { exit: InterfaceId }) =>
    ({ kind: 'interface', interface: a.exit }) as const;
  return [
    routerCommand({
      modes: GLOBAL,
      path: [ipv6Kw, keyword('unicast-routing', 'Enable unicast routing')],
      run: (_a, ctx) => {
        ctx.device.config.ipv6UnicastRouting = true;
        return NOTHING;
      },
      no: (_a, ctx) => {
        delete ctx.device.config.ipv6UnicastRouting;
        return NOTHING;
      },
    }),
    routerCommand({
      modes: GLOBAL,
      path: [...route, nextHop],
      run: (a, ctx) => setRoute(ctx, a.prefix, viaAddress(a), undefined),
      no,
    }),
    routerCommand({
      modes: GLOBAL,
      path: [...route, nextHop, distance],
      run: (a, ctx) => setRoute(ctx, a.prefix, viaAddress(a), a.distance),
      no,
    }),
    routerCommand({
      modes: GLOBAL,
      path: [...route, exit],
      run: (a, ctx) => setRoute(ctx, a.prefix, viaInterface(a), undefined),
      no,
    }),
    routerCommand({
      modes: GLOBAL,
      path: [...route, exit, distance],
      run: (a, ctx) => setRoute(ctx, a.prefix, viaInterface(a), a.distance),
      no,
    }),
    routerCommand({
      modes: GLOBAL,
      path: [...route, exit, nextHop],
      run: (a, ctx) => setRoute(ctx, a.prefix, viaAddress(a), undefined),
      no,
    }),
    routerCommand({
      modes: GLOBAL,
      path: [...route, exit, nextHop, distance],
      run: (a, ctx) => setRoute(ctx, a.prefix, viaAddress(a), a.distance),
      no,
    }),
  ];
}

function execCommands() {
  const show = keyword('show', 'Show running system information');
  const showIpv6 = keyword('ipv6', 'IPv6 information');
  const showInterface = keyword('interface', 'IPv6 interface status and configuration');
  const pingTarget = ipv6('target', 'Ping destination address');
  const traceTarget = ipv6('target', 'Trace route to destination address');
  return [
    routerCommand({
      modes: EXEC,
      path: [
        show,
        showIpv6,
        showInterface,
        keyword('brief', 'Brief summary of IPv6 status and configuration'),
      ],
      run: (_a, ctx) => ctx.query('ipv6', showIpv6InterfaceBrief),
    }),
    routerCommand({
      modes: EXEC,
      path: [show, showIpv6, showInterface],
      run: (_a, ctx) => ctx.query('ipv6', (status, device) => showIpv6Interface(status, device)),
    }),
    routerCommand({
      modes: EXEC,
      path: [show, showIpv6, showInterface, iface('name', 'Interface name')],
      run: ({ name }, ctx) =>
        findInterface(ctx.device, name)
          ? ctx.query('ipv6', (status, device) => showIpv6Interface(status, device, name))
          : ctx.reject(INVALID_INPUT),
    }),
    routerCommand({
      modes: EXEC,
      path: [show, showIpv6, keyword('route', 'Show IPv6 route table entries')],
      run: (_a, ctx) => ctx.query('ipv6', showIpv6Route),
    }),
    routerCommand({
      modes: EXEC,
      path: [show, showIpv6, keyword('neighbors', 'Show IPv6 neighbor cache entries')],
      run: (_a, ctx) => ctx.query('ipv6', showIpv6Neighbors),
    }),
    ...pingCommands([], pingTarget),
    ...pingCommands([keyword('ipv6', 'IPv6 echo')], pingTarget),
    tracerouteCommand([], traceTarget),
    tracerouteCommand([keyword('ipv6', 'IPv6 trace')], traceTarget),
  ];
}

/** IPv6 on routers: interface addresses, unicast routing, static routes, show, ping, traceroute. */
export const ipv6Commands = [...interfaceCommands(), ...globalCommands(), ...execCommands()];
