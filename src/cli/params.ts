import {
  expandInterfaceRange,
  INTERFACE_TYPES,
  normalizeInterface,
  resolveInterfaceType,
  type InterfaceName,
} from './interfaces';

export type Ipv4Address = string & { readonly __brand: 'Ipv4Address' };
export type SubnetMask = string & { readonly __brand: 'SubnetMask' };

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

function ipv4ToNumber(text: string): number | undefined {
  const parts = text.split('.');
  if (parts.length !== 4) return undefined;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return undefined;
    n = n * 256 + Number(part);
  }
  return n;
}

function isContiguousMask(n: number): boolean {
  const inverted = ~n >>> 0;
  return (inverted & (inverted + 1)) === 0;
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
  const read = (text: string) =>
    ipv4ToNumber(text) === undefined ? undefined : (text as Ipv4Address);
  return param(name, help, singleToken('ipv4', 'A.B.C.D', read));
}

export function mask<N extends string>(name: N, help: string): Param<N, SubnetMask> {
  const read = (text: string) => {
    const n = ipv4ToNumber(text);
    return n !== undefined && isContiguousMask(n) ? (text as SubnetMask) : undefined;
  };
  return param(name, help, singleToken('mask', 'A.B.C.D', read));
}

const interfaceEntries = () => INTERFACE_TYPES.map((t) => ({ name: t.name, help: t.help }));

function completeInterfaceType(partial: string): readonly string[] {
  if (!/^[a-z]+$/i.test(partial)) return [];
  const p = partial.toLowerCase();
  return INTERFACE_TYPES.map((t) => t.name).filter((name) => name.toLowerCase().startsWith(p));
}

/** One interface, written `g0/0` or `gi 0/0`. */
export function iface<N extends string>(name: N, help: string): Param<N, InterfaceName> {
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
): Param<N, readonly InterfaceName[]> {
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
