import {
  Ipv4Address,
  normalizeVlans,
  SubnetMask,
  type InterfaceId,
  type PrefixLength,
  type VlanId,
  type VlanRange,
} from '../model';
import { readIpv6, readIpv6Cidr, type Ipv6Address, type Ipv6Cidr } from '../model/ipv6';
import {
  expandInterfaceRange,
  INTERFACE_TYPES,
  normalizeInterface,
  resolveInterfaceType,
} from './interfaces';

export interface Token {
  readonly text: string;
  /** Column of the first character in the input line. */
  readonly start: number;
}

export interface ParamInput {
  readonly line: string;
  readonly tokens: readonly Token[];
  readonly index: number;
}

export interface HelpEntry {
  readonly name: string;
  readonly help: string;
}

export type MatchResult<T> =
  | { readonly kind: 'ok'; readonly value: T; readonly next: number }
  | { readonly kind: 'fail'; readonly column: number }
  | { readonly kind: 'incomplete' };

export interface ParamType<T> {
  /** Two params merge into one tree node when their names and ids match. */
  readonly id: string;
  /** Consumes every remaining token, so it must end its command. */
  readonly restOfLine: boolean;
  readonly match: (input: ParamInput) => MatchResult<T>;
  readonly entries: (help: string) => readonly HelpEntry[];
  /** Words that Tab and `x?` offer for a partial token. */
  readonly complete: (partial: string) => readonly string[];
}

export interface Keyword {
  readonly kind: 'keyword';
  readonly word: string;
  readonly help: string;
}

export interface Param<N extends string, T> {
  readonly kind: 'param';
  readonly name: N;
  readonly help: string;
  readonly type: ParamType<T>;
}

export type Segment = Keyword | Param<string, unknown>;

const INCOMPLETE = { kind: 'incomplete' } as const;
const ok = <T>(value: T, next: number): MatchResult<T> => ({ kind: 'ok', value, next });
const fail = (column: number): MatchResult<never> => ({ kind: 'fail', column });
const noCompletions = (): readonly string[] => [];

export function keyword(word: string, help: string): Keyword {
  return { kind: 'keyword', word: word.toLowerCase(), help };
}

function param<N extends string, T>(name: N, help: string, type: ParamType<T>): Param<N, T> {
  return { kind: 'param', name, help, type };
}

function singleToken<T>(id: string, label: string, read: (text: string) => T | undefined) {
  return {
    id,
    restOfLine: false,
    match: ({ tokens, index }: ParamInput): MatchResult<T> => {
      const token = tokens[index];
      if (!token) return INCOMPLETE;
      const value = read(token.text);
      return value === undefined ? fail(token.start) : ok(value, index + 1);
    },
    entries: (help: string) => [{ name: label, help }],
    complete: noCompletions,
  } satisfies ParamType<T>;
}

const UNFINISHED = Symbol('unfinished');

function restOfLine<T>(
  id: string,
  read: (text: string) => T | undefined | typeof UNFINISHED,
  base: Pick<ParamType<T>, 'entries' | 'complete'>,
): ParamType<T> {
  return {
    id,
    restOfLine: true,
    ...base,
    match: ({ line, tokens, index }) => {
      const token = tokens[index];
      if (!token) return INCOMPLETE;
      const value = read(line.slice(token.start).trimEnd());
      if (value === UNFINISHED) return INCOMPLETE;
      return value === undefined ? fail(token.start) : ok(value, tokens.length);
    },
  };
}

export function word<N extends string>(name: N, help: string): Param<N, string> {
  return param(
    name,
    help,
    singleToken('word', 'WORD', (text) => text),
  );
}

export function num<N extends string>(
  name: N,
  min: number,
  max: number,
  help: string,
): Param<N, number> {
  const read = (text: string) => {
    const n = /^\d+$/.test(text) ? Number(text) : NaN;
    return n >= min && n <= max ? n : undefined;
  };
  return param(name, help, singleToken(`number:${min}-${max}`, `<${min}-${max}>`, read));
}

export function ipv4<N extends string>(name: N, help: string): Param<N, Ipv4Address> {
  return param(
    name,
    help,
    singleToken('ipv4', 'A.B.C.D', (text) => Ipv4Address.safeParse(text).data),
  );
}

/** A dotted subnet mask such as `255.255.255.0`, read as its prefix length. */
export function mask<N extends string>(name: N, help: string): Param<N, PrefixLength> {
  return param(
    name,
    help,
    singleToken('mask', 'A.B.C.D', (text) => SubnetMask.safeParse(text).data),
  );
}

/** An IPv6 address in any text form, such as `2001:db8::1`, read as its canonical form. */
export function ipv6<N extends string>(name: N, help: string): Param<N, Ipv6Address> {
  return param(name, help, singleToken('ipv6', 'X:X:X:X::X', readIpv6));
}

/** An IPv6 address and prefix length, such as `2001:db8:1::1/64`. The host bits stay. */
export function ipv6Prefix<N extends string>(name: N, help: string): Param<N, Ipv6Cidr> {
  return param(name, help, singleToken('ipv6-prefix', 'X:X:X:X::X/<0-128>', readIpv6Cidr));
}

/**
 * One of a fixed set of words, such as `speed 10|100|1000|auto`. An exact word wins over a word it
 * prefixes, so `10` picks 10 rather than being ambiguous with 100.
 */
export function choice<N extends string, const W extends string>(
  name: N,
  words: Readonly<Record<W, string>>,
): Param<N, W> {
  const all = Object.keys(words) as W[];
  const matching = (partial: string) => {
    const p = partial.toLowerCase();
    return all.filter((w) => w.startsWith(p));
  };
  const read = (text: string): W | undefined => {
    const exact = all.find((w) => w === text.toLowerCase());
    const prefixed = matching(text);
    return exact ?? (prefixed.length === 1 ? prefixed[0] : undefined);
  };
  return param(name, '', {
    ...singleToken(`choice:${all.join('|')}`, '', read),
    entries: () => all.map((w) => ({ name: w, help: words[w] })),
    complete: matching,
  });
}

const interfaceEntries = () => INTERFACE_TYPES.map((t) => ({ name: t.name, help: t.help }));

function completeInterfaceType(partial: string): readonly string[] {
  if (!/^[a-z]+$/i.test(partial)) return [];
  const p = partial.toLowerCase();
  return INTERFACE_TYPES.map((t) => t.name).filter((name) => name.toLowerCase().startsWith(p));
}

/** One interface, written `g0/0` or `gi 0/0`. */
export function iface<N extends string>(name: N, help: string): Param<N, InterfaceId> {
  return param(name, help, {
    id: 'interface',
    restOfLine: false,
    entries: interfaceEntries,
    complete: completeInterfaceType,
    match: ({ tokens, index }) => {
      const first = tokens[index];
      if (!first) return INCOMPLETE;
      const [, prefix = '', port = ''] = /^([a-z]+)(.*)$/i.exec(first.text) ?? [];
      if (!resolveInterfaceType(prefix)) return fail(first.start);
      if (port) {
        const value = normalizeInterface(first.text);
        return value ? ok(value, index + 1) : fail(first.start);
      }
      const second = tokens[index + 1];
      if (!second) return INCOMPLETE;
      const value = normalizeInterface(prefix + second.text);
      return value ? ok(value, index + 2) : fail(second.start);
    },
  });
}

/** One interface or a range such as `f0/1 - 5`. Takes the rest of the line. */
export function ifaceRange<N extends string>(
  name: N,
  help: string,
): Param<N, readonly InterfaceId[]> {
  const read = (text: string) => {
    const names = expandInterfaceRange(text);
    if (names) return names;
    const typeOnly = /^[a-z]+$/i.test(text) && resolveInterfaceType(text) !== undefined;
    return typeOnly || /-\s*$/.test(text) ? UNFINISHED : undefined;
  };
  return param(
    name,
    help,
    restOfLine('interface-range', read, {
      entries: interfaceEntries,
      complete: completeInterfaceType,
    }),
  );
}

/** Free text to the end of the line, such as a description. */
export function line<N extends string>(name: N, help: string): Param<N, string> {
  return param(
    name,
    help,
    restOfLine('line', (text) => text, {
      entries: (help) => [{ name: 'LINE', help }],
      complete: noCompletions,
    }),
  );
}

const VLAN_RANGE = /^(\d+)(?:-(\d+))?$/;
const MAX_VLAN = 4094;

function readVlanList(text: string): readonly VlanRange[] | undefined {
  const ranges: VlanRange[] = [];
  for (const part of text.split(',')) {
    const [, from = '', to] = VLAN_RANGE.exec(part) ?? [];
    const first = Number(from);
    const last = to === undefined ? first : Number(to);
    if (!from || first < 1 || last > MAX_VLAN || last < first) return undefined;
    ranges.push({ first: first as VlanId, last: last as VlanId });
  }
  return normalizeVlans(ranges);
}

/** A VLAN list such as `1,10,20-30`, read as sorted ranges. */
export function vlanList<N extends string>(name: N, help: string): Param<N, readonly VlanRange[]> {
  return param(name, help, singleToken('vlan-list', 'WORD', readVlanList));
}
