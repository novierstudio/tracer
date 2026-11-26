import type { Draft } from 'immer';
import {
  ipv4ToUint32,
  prefixMask,
  type InterfaceId,
  type Ipv4Address,
  type NatConfig,
  type NatDynamic,
  type PrefixLength,
} from '../../model';
import { choice, iface, ipv4, keyword, mask, num, word } from '../params';
import { defineCommand } from '../tree';
import { aclName, eachRoutedInterface } from './acl';
import { INVALID_INPUT, type RouterContext } from './context';
import { findInterface } from './show';
import { showIpNatTranslations } from './showAclNat';

const routerCommand = defineCommand<RouterContext>();

const EXEC = ['user-exec', 'priv-exec'] as const;
const PRIV = ['priv-exec'] as const;
const GLOBAL = ['global-config'] as const;
const ANY_IF = ['interface-config', 'subinterface-config'] as const;

const NOTHING: readonly string[] = [];
const INCOMPLETE = '% Incomplete command.';

const globalIp = keyword('ip', 'Global IP configuration subcommands');
const natKw = keyword('nat', 'NAT configuration commands');
const inside = keyword('inside', 'Inside address translation');
const source = keyword('source', 'Source address translation');
const overload = keyword('overload', 'Overload an address translation');

/** The router's NAT config, created by its first global `ip nat` command. */
function natOf(ctx: RouterContext): Draft<NatConfig> {
  return (ctx.device.config.nat ??= { pools: {}, statics: [], dynamic: [] });
}

/** Drops the NAT config once nothing is left in it, so it stays out of the file. */
function tidy(ctx: RouterContext) {
  const { nat } = ctx.device.config;
  if (nat && Object.keys(nat.pools).length === 0 && !nat.statics.length && !nat.dynamic.length) {
    delete ctx.device.config.nat;
  }
}

/** IOS refuses a pool whose ends are not in one subnet of its netmask, or that runs backwards. */
function addPool(
  ctx: RouterContext,
  name: string,
  first: Ipv4Address,
  last: Ipv4Address,
  prefixLength: PrefixLength,
) {
  const network = (address: Ipv4Address) =>
    (ipv4ToUint32(address) & prefixMask(prefixLength)) >>> 0;
  if (network(first) !== network(last))
    return ctx.reject('%Start and end addresses on different subnets');
  if (ipv4ToUint32(last) < ipv4ToUint32(first))
    return ctx.reject('%End address less than starting address');
  natOf(ctx).pools[name] = { first, last, prefixLength };
  return NOTHING;
}

function removePool(ctx: RouterContext, name: string | undefined) {
  if (name === undefined) return ctx.reject(INCOMPLETE);
  delete ctx.device.config.nat?.pools[name];
  tidy(ctx);
  return NOTHING;
}

/** A rule for an access list replaces the list's earlier rule, as IOS keeps one per list. */
function setDynamic(ctx: RouterContext, rule: NatDynamic) {
  const nat = natOf(ctx);
  const at = nat.dynamic.findIndex((existing) => existing.acl === rule.acl);
  if (at === -1) nat.dynamic.push(rule);
  else nat.dynamic[at] = rule;
  return NOTHING;
}

function removeDynamic(ctx: RouterContext, acl: string | undefined) {
  if (acl === undefined) return ctx.reject(INCOMPLETE);
  const nat = ctx.device.config.nat;
  if (nat) nat.dynamic = nat.dynamic.filter((rule) => rule.acl !== acl);
  tidy(ctx);
  return NOTHING;
}

function poolCommands() {
  const named = [
    globalIp,
    natKw,
    keyword('pool', 'Define pool of addresses'),
    word('name', 'Pool name'),
  ] as const;
  const head = [
    ...named,
    ipv4('first', 'Start IP address'),
    ipv4('last', 'End IP address'),
  ] as const;
  return [
    // `no ip nat pool NAME` needs only the name.
    routerCommand({
      modes: GLOBAL,
      path: named,
      run: (_a, ctx) => ctx.reject(INCOMPLETE),
      no: (a, ctx) => removePool(ctx, a.name),
    }),
    routerCommand({
      modes: GLOBAL,
      path: [...head, keyword('netmask', 'Specify the network mask'), mask('mask', 'Network mask')],
      run: (a, ctx) => addPool(ctx, a.name, a.first, a.last, a.mask),
    }),
    routerCommand({
      modes: GLOBAL,
      path: [
        ...head,
        keyword('prefix-length', 'Specify the prefix length'),
        num('length', 1, 32, 'Prefix length'),
      ],
      run: (a, ctx) => addPool(ctx, a.name, a.first, a.last, a.length as PrefixLength),
    }),
  ];
}

function sourceCommands() {
  const head = [globalIp, natKw, inside, source] as const;
  const list = [
    ...head,
    keyword('list', 'Specify access list describing local addresses'),
    aclName('acl', 'Access list number for local addresses'),
  ] as const;
  const poolPath = [
    ...list,
    keyword('pool', 'Name pool of global addresses'),
    word('pool', 'Pool name'),
  ] as const;
  const interfacePath = [
    ...list,
    keyword('interface', 'Specify interface for global address'),
    iface('interface', 'Interface name'),
  ] as const;
  const toInterface = (acl: string, name: InterfaceId, overloaded: boolean, ctx: RouterContext) =>
    findInterface(ctx.device, name)
      ? setDynamic(ctx, { acl, to: { kind: 'interface', interface: name }, overload: overloaded })
      : ctx.reject(INVALID_INPUT);
  return [
    routerCommand({
      modes: GLOBAL,
      path: [
        ...head,
        keyword('static', 'Specify static local->global mapping'),
        ipv4('local', 'Inside local IP address'),
        ipv4('global', 'Inside global IP address'),
      ],
      run: ({ local, global }, ctx) => {
        const nat = natOf(ctx);
        nat.statics = nat.statics.filter((m) => m.local !== local && m.global !== global);
        nat.statics.push({ local, global });
        return NOTHING;
      },
      no: ({ local, global }, ctx) => {
        if (local === undefined || global === undefined) return ctx.reject(INCOMPLETE);
        const nat = ctx.device.config.nat;
        if (nat) nat.statics = nat.statics.filter((m) => m.local !== local || m.global !== global);
        tidy(ctx);
        return NOTHING;
      },
    }),
    routerCommand({
      modes: GLOBAL,
      path: poolPath,
      run: ({ acl, pool }, ctx) =>
        setDynamic(ctx, { acl, to: { kind: 'pool', pool }, overload: false }),
      no: ({ acl }, ctx) => removeDynamic(ctx, acl),
    }),
    routerCommand({
      modes: GLOBAL,
      path: [...poolPath, overload],
      run: ({ acl, pool }, ctx) =>
        setDynamic(ctx, { acl, to: { kind: 'pool', pool }, overload: true }),
      no: ({ acl }, ctx) => removeDynamic(ctx, acl),
    }),
    routerCommand({
      modes: GLOBAL,
      path: interfacePath,
      run: ({ acl, interface: name }, ctx) => toInterface(acl, name, false, ctx),
      no: ({ acl }, ctx) => removeDynamic(ctx, acl),
    }),
    routerCommand({
      modes: GLOBAL,
      path: [...interfacePath, overload],
      run: ({ acl, interface: name }, ctx) => toInterface(acl, name, true, ctx),
      no: ({ acl }, ctx) => removeDynamic(ctx, acl),
    }),
  ];
}

function interfaceCommands() {
  return [
    routerCommand({
      modes: ANY_IF,
      path: [
        keyword('ip', 'Interface Internet Protocol config commands'),
        natKw,
        choice('role', {
          inside: 'Inside interface for address translation',
          outside: 'Outside interface for address translation',
        }),
      ],
      run: ({ role }, ctx, mode) =>
        eachRoutedInterface(ctx, mode, (config) => void (config.nat = role)),
      no: ({ role }, ctx, mode) =>
        eachRoutedInterface(ctx, mode, (config) => {
          if (role === undefined || config.nat === role) delete config.nat;
        }),
    }),
  ];
}

function execCommands() {
  return [
    routerCommand({
      modes: EXEC,
      path: [
        keyword('show', 'Show running system information'),
        keyword('ip', 'IP information'),
        natKw,
        keyword('translations', 'Translation entries'),
      ],
      run: (_a, ctx) => ctx.query('natTranslations', showIpNatTranslations),
    }),
    routerCommand({
      modes: PRIV,
      path: [
        keyword('clear', 'Reset functions'),
        keyword('ip', 'IP'),
        natKw,
        keyword('translation', 'Clear dynamic translation'),
        keyword('*', 'Delete all dynamic translations'),
      ],
      run: (_a, ctx) => ctx.query('natCleared', () => NOTHING),
    }),
  ];
}

/** Inside source NAT on routers: interfaces' roles, pools, rules, and the translation table. */
export const natCommands = [
  ...interfaceCommands(),
  ...poolCommands(),
  ...sourceCommands(),
  ...execCommands(),
];
