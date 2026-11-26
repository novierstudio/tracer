import type { Draft } from 'immer';
import {
  AclName,
  ipv4ToUint32,
  Ipv4Address,
  uint32ToIpv4,
  type AccessList,
  type AclAddress,
  type AclIcmpType,
  type AclPort,
  type AclProtocol,
  type RoutedInterface,
  type Subinterface,
} from '../../model';
import type { ModeOf } from '../modes';
import {
  choice,
  keyword,
  line,
  num,
  type HelpEntry,
  type MatchResult,
  type Param,
  type ParamType,
  type Token,
} from '../params';
import { defineCommand } from '../tree';
import { INVALID_INPUT, type DeviceContext } from './context';
import { findInterface } from './show';
import {
  ANY,
  NO_WILDCARD,
  numberedType,
  PORT_NAMES,
  showAccessLists,
  type AclEntry,
  type AclType,
  type ExtendedRule,
  type StandardRule,
} from './showAclNat';

const command = defineCommand<DeviceContext>();

const EXEC = ['user-exec', 'priv-exec'] as const;
const GLOBAL = ['global-config'] as const;
const ANY_IF = ['interface-config', 'subinterface-config'] as const;
const STD = ['std-acl-config'] as const;
const EXT = ['ext-acl-config'] as const;

const NOTHING: readonly string[] = [];

type StandardMatch = Omit<StandardRule, 'kind' | 'action'>;
type ExtendedMatch = Omit<ExtendedRule, 'kind' | 'action'>;

const ICMP_TYPES: readonly AclIcmpType[] = ['echo', 'echo-reply', 'unreachable', 'time-exceeded'];
const PORT_OPS = ['eq', 'neq', 'gt', 'lt', 'range'] as const;
const PROTOCOLS: Readonly<Record<AclProtocol, string>> = {
  icmp: 'Internet Control Message Protocol',
  ip: 'Any Internet Protocol',
  tcp: 'Transmission Control Protocol',
  udp: 'User Datagram Protocol',
};

/** Stops a rule's parse: at a token that does not fit, or at the end of a line that is not done. */
class Stop {
  constructor(readonly column: number | undefined) {}
}

/** Reads a rule's tokens left to right. A keyword may be any unique prefix of itself, as on IOS. */
function reader(tokens: readonly Token[], start: number) {
  let at = start;
  const next = () => {
    const token = tokens[at];
    if (!token) throw new Stop(undefined);
    return token;
  };
  const prefixed = <W extends string>(text: string, words: readonly W[]) => {
    const lower = text.toLowerCase();
    const found = words.filter((w) => w.startsWith(lower));
    return words.find((w) => w === lower) ?? (found.length === 1 ? found[0] : undefined);
  };
  return {
    /** The next token as one of `words`, or undefined, consuming nothing, when it is not one. */
    maybe<W extends string>(words: readonly W[]): W | undefined {
      const token = tokens[at];
      const found = token && prefixed(token.text, words);
      if (found) at++;
      return found;
    },
    word<W extends string>(words: readonly W[]): W {
      const token = next();
      const found = prefixed(token.text, words);
      if (!found) throw new Stop(token.start);
      at++;
      return found;
    },
    address(): Ipv4Address {
      const token = next();
      const parsed = Ipv4Address.safeParse(token.text);
      if (!parsed.success) throw new Stop(token.start);
      at++;
      return parsed.data;
    },
    maybeAddress(): Ipv4Address | undefined {
      const parsed = Ipv4Address.safeParse(tokens[at]?.text);
      if (parsed.success) at++;
      return parsed.data;
    },
    port(protocol: 'tcp' | 'udp'): number {
      const token = next();
      const names = PORT_NAMES[protocol];
      const named = prefixed(token.text, Object.keys(names));
      const port = named ? names[named]! : /^\d+$/.test(token.text) ? Number(token.text) : NaN;
      if (!(port >= 0 && port <= 65535)) throw new Stop(token.start);
      at++;
      return port;
    },
    /** Fails at the last token read. */
    fail(): never {
      throw new Stop(tokens[at - 1]?.start);
    },
    /** Fails at the first token past the rule, if there is one. */
    end() {
      const extra = tokens[at];
      if (extra) throw new Stop(extra.start);
    },
  };
}

type Reader = ReturnType<typeof reader>;

/** Keeps only the address bits the wildcard compares, as IOS stores an entry. */
function aclAddress(address: Ipv4Address, wildcard: Ipv4Address): AclAddress {
  const kept = (ipv4ToUint32(address) & ~ipv4ToUint32(wildcard)) >>> 0;
  return { address: uint32ToIpv4(kept), wildcard };
}

/** `any`, `host A`, or `A W`. A standard list takes `A` alone as one host. */
function readAddress(r: Reader, standard: boolean): AclAddress {
  const word = r.maybe(['any', 'host']);
  if (word === 'any') return ANY;
  if (word === 'host') return { address: r.address(), wildcard: NO_WILDCARD };
  const address = r.address();
  const wildcard = standard ? (r.maybeAddress() ?? NO_WILDCARD) : r.address();
  return aclAddress(address, wildcard);
}

function readPort(r: Reader, protocol: 'tcp' | 'udp'): AclPort | undefined {
  const op = r.maybe(PORT_OPS);
  if (op === undefined) return undefined;
  if (op !== 'range') return { op, port: r.port(protocol) };
  const first = r.port(protocol);
  const last = r.port(protocol);
  if (last < first) r.fail();
  return { op, first, last };
}

function readStandard(r: Reader): StandardMatch {
  return { source: readAddress(r, true) };
}

function readExtended(r: Reader): ExtendedMatch {
  const protocol = r.word(Object.keys(PROTOCOLS) as AclProtocol[]);
  const transport = protocol === 'tcp' || protocol === 'udp' ? protocol : undefined;
  const source = readAddress(r, false);
  const sourcePort = transport && readPort(r, transport);
  const destination = readAddress(r, false);
  const destinationPort = transport && readPort(r, transport);
  const icmpType = protocol === 'icmp' ? r.maybe(ICMP_TYPES) : undefined;
  return {
    protocol,
    source,
    ...(sourcePort && { sourcePort }),
    destination,
    ...(destinationPort && { destinationPort }),
    ...(icmpType && { icmpType }),
  };
}

const INCOMPLETE = { kind: 'incomplete' } as const;

/** A rule's match, read from the rest of the line. The caret lands on the first token that does not fit. */
function ruleParam<N extends string, T>(
  name: N,
  read: (r: Reader) => T,
  entries: readonly HelpEntry[],
): Param<N, T> {
  const words = entries.map((entry) => entry.name).filter((word) => /^[a-z]/.test(word));
  const type: ParamType<T> = {
    id: `acl-rule:${name}`,
    restOfLine: true,
    entries: () => entries,
    complete: (partial) => words.filter((word) => word.startsWith(partial.toLowerCase())),
    match: ({ tokens, index }): MatchResult<T> => {
      if (!tokens[index]) return INCOMPLETE;
      const r = reader(tokens, index);
      try {
        const value = read(r);
        r.end();
        return { kind: 'ok', value, next: tokens.length };
      } catch (stop) {
        if (!(stop instanceof Stop)) throw stop;
        return stop.column === undefined ? INCOMPLETE : { kind: 'fail', column: stop.column };
      }
    },
  };
  return { kind: 'param', name, help: '', type };
}

const standardRule = ruleParam('match', readStandard, [
  { name: 'A.B.C.D', help: 'Address to match' },
  { name: 'any', help: 'Any source host' },
  { name: 'host', help: 'A single host address' },
]);

const extendedRule = ruleParam(
  'match',
  readExtended,
  Object.entries(PROTOCOLS).map(([name, help]) => ({ name, help })),
);

/** A list's number or name, as `ip access-group` and `ip nat inside source list` take it. */
export function aclName<N extends string>(name: N, help: string): Param<N, AclName> {
  const type: ParamType<AclName> = {
    id: 'acl-name',
    restOfLine: false,
    entries: () => [
      { name: '<1-199>', help },
      { name: 'WORD', help: 'Access-list name' },
    ],
    complete: () => [],
    match: ({ tokens, index }) => {
      const token = tokens[index];
      if (!token) return INCOMPLETE;
      const parsed = AclName.safeParse(token.text);
      return parsed.success
        ? { kind: 'ok', value: parsed.data, next: index + 1 }
        : { kind: 'fail', column: token.start };
    },
  };
  return { kind: 'param', name, help, type };
}

const action = choice('action', {
  deny: 'Specify packets to reject',
  permit: 'Specify packets to forward',
});

const TYPE_TAKEN: Readonly<Record<AclType, string>> = {
  standard: '% A named extended IP access list with this name already exists',
  extended: '% A named standard IP access list with this name already exists',
};

/** Adds an entry to list `name`, creating it. Refused when a list of the other type has the name. */
function addEntry(ctx: DeviceContext, name: string, type: AclType, entry: AclEntry) {
  const lists = (ctx.device.config.accessLists ??= {});
  const list = (lists[name] ??= { type, entries: [] } as Draft<AccessList>);
  if (list.type !== type) return ctx.reject(TYPE_TAKEN[type]);
  (list.entries as Draft<AclEntry>[]).push(entry);
  return NOTHING;
}

function removeList(ctx: DeviceContext, name: string) {
  const lists = ctx.device.config.accessLists;
  if (!lists) return NOTHING;
  delete lists[name];
  if (Object.keys(lists).length === 0) delete ctx.device.config.accessLists;
  return NOTHING;
}

type InterfaceMode = ModeOf<'interface-config' | 'subinterface-config'>;

/**
 * Applies `edit` to the routed config of each interface of the mode: a router's port,
 * subinterface or loopback, or a switch's VLAN interface. A switchport refuses the command.
 */
export function eachRoutedInterface(
  ctx: DeviceContext,
  mode: InterfaceMode,
  edit: (config: Draft<RoutedInterface | Subinterface>) => void,
): readonly string[] {
  const ids = mode.kind === 'interface-config' ? mode.interfaces : [mode.interface];
  for (const id of ids) {
    const target = findInterface(ctx.device, id);
    if (!target || target.kind === 'switched') return ctx.reject(INVALID_INPUT);
    edit(target.config as Draft<RoutedInterface | Subinterface>);
  }
  return NOTHING;
}

const DIRECTION_FIELD = { in: 'accessGroupIn', out: 'accessGroupOut' } as const;

const accessListKw = keyword('access-list', 'Add an access list entry');
const remarkKw = keyword('remark', 'Access list entry comment');
const remarkText = line('text', 'Comment up to 100 characters');
const standardNumber = num('number', 1, 99, 'IP standard access list');
const extendedNumber = num('number', 100, 199, 'IP extended access list');

/** `access-list N ...` for one range of numbers: its rules, its remarks, and `no access-list N`. */
function numberedCommands(
  number: typeof standardNumber,
  type: AclType,
  rule: Param<'match', StandardMatch | ExtendedMatch>,
) {
  return [
    command({
      modes: GLOBAL,
      path: [accessListKw, number, action, rule],
      run: ({ number, action, match }, ctx) =>
        addEntry(ctx, String(number), type, { kind: 'rule', action, ...match } as AclEntry),
      no: ({ number }, ctx) =>
        number === undefined
          ? ctx.reject('% Incomplete command.')
          : removeList(ctx, String(number)),
    }),
    command({
      modes: GLOBAL,
      path: [accessListKw, number, remarkKw, remarkText],
      run: ({ number, text }, ctx) => addEntry(ctx, String(number), type, { kind: 'remark', text }),
    }),
  ];
}

/** `ip access-list standard|extended NAME`, which opens the list for its own entry lines. */
function namedListCommands() {
  const ipKw = keyword('ip', 'Global IP configuration subcommands');
  const listKw = keyword('access-list', 'Named access-list');
  const types: readonly [AclType, string, 'std-acl-config' | 'ext-acl-config'][] = [
    ['standard', 'Standard Access List', 'std-acl-config'],
    ['extended', 'Extended Access List', 'ext-acl-config'],
  ];
  const opening = types.map(([type, help, mode]) =>
    command({
      modes: GLOBAL,
      path: [ipKw, listKw, keyword(type, help), aclName('name', 'Access-list name')],
      to: ({ name }) => ({ kind: mode, name }),
      run: ({ name }, ctx) => {
        const numbered = numberedType(name);
        if (numbered !== undefined && numbered !== type) return ctx.reject(INVALID_INPUT);
        const existing = ctx.device.config.accessLists?.[name];
        if (existing && existing.type !== type) return ctx.reject(TYPE_TAKEN[type]);
        if (!existing) (ctx.device.config.accessLists ??= {})[name] = { type, entries: [] };
        return NOTHING;
      },
      no: ({ name }, ctx) =>
        name === undefined ? ctx.reject('% Incomplete command.') : removeList(ctx, name),
    }),
  );
  const entries = (
    modes: typeof STD | typeof EXT,
    type: AclType,
    rule: Param<'match', StandardMatch | ExtendedMatch>,
  ) => [
    command({
      modes,
      path: [action, rule],
      run: ({ action, match }, ctx, mode) =>
        addEntry(ctx, mode.name, type, { kind: 'rule', action, ...match } as AclEntry),
    }),
    command({
      modes,
      path: [remarkKw, remarkText],
      run: ({ text }, ctx, mode) => addEntry(ctx, mode.name, type, { kind: 'remark', text }),
    }),
  ];
  return [
    ...opening,
    ...entries(STD, 'standard', standardRule),
    ...entries(EXT, 'extended', extendedRule),
  ];
}

function accessGroupCommands() {
  const path = [
    keyword('ip', 'Interface Internet Protocol config commands'),
    keyword('access-group', 'Specify access control for packets'),
    aclName('acl', 'IP access list (standard or extended)'),
    choice('direction', { in: 'inbound packets', out: 'outbound packets' }),
  ] as const;
  return [
    command({
      modes: ANY_IF,
      path,
      run: ({ acl, direction }, ctx, mode) =>
        eachRoutedInterface(ctx, mode, (config) => {
          config[DIRECTION_FIELD[direction]] = acl;
        }),
      no: ({ acl, direction }, ctx, mode) =>
        eachRoutedInterface(ctx, mode, (config) => {
          const directions = direction ? [direction] : (['in', 'out'] as const);
          for (const field of directions.map((d) => DIRECTION_FIELD[d])) {
            if (acl === undefined || config[field] === acl) delete config[field];
          }
        }),
    }),
  ];
}

function showCommands() {
  const show = keyword('show', 'Show running system information');
  const lists = keyword('access-lists', 'List access lists');
  const name = aclName('name', 'ACL number or name');
  return [[], [keyword('ip', 'IP information')]].flatMap((ip) => [
    command({
      modes: EXEC,
      path: [show, ...ip, lists],
      run: (_a, ctx) => ctx.query('aclHits', (hits, device) => showAccessLists(hits, device)),
    }),
    command({
      modes: EXEC,
      path: [show, ...ip, lists, name],
      run: (a, ctx) =>
        ctx.query('aclHits', (hits, device) => showAccessLists(hits, device, a.name)),
    }),
  ]);
}

/** Access lists on routers and switches: defining them, applying them, and showing their hits. */
export const aclCommands = [
  ...numberedCommands(standardNumber, 'standard', standardRule),
  ...numberedCommands(extendedNumber, 'extended', extendedRule),
  ...namedListCommands(),
  ...accessGroupCommands(),
  ...showCommands(),
];
