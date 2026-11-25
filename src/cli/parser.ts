import { isConfigMode, PRIV_EXEC, type Mode } from './modes';
import type { HelpEntry, Token } from './params';
import type { CommandTree, TrieNode } from './tree';

export type CliError =
  | { readonly kind: 'invalid'; readonly column: number }
  | { readonly kind: 'ambiguous'; readonly input: string }
  | { readonly kind: 'incomplete' };

export type HelpError = CliError | { readonly kind: 'unrecognized' };

export interface ParsedCommand<Ctx> {
  readonly kind: 'command';
  /** The command's keywords joined by spaces, such as `ip address`. */
  readonly command: string;
  readonly negated: boolean;
  readonly args: Readonly<Record<string, unknown>>;
  /** The mode after the command runs. A `do` command leaves the mode alone. */
  readonly mode: Mode;
  /** Runs the handler and returns its output lines. */
  readonly execute: (ctx: Ctx) => readonly string[];
}

export type ParseResult<Ctx> =
  | { readonly kind: 'empty' }
  | { readonly kind: 'error'; readonly error: CliError }
  | ParsedCommand<Ctx>;

export type HelpResult =
  /** `show ?` lists what may come next. */
  | { readonly kind: 'options'; readonly options: readonly HelpEntry[] }
  /** `sh?` lists the words that start with the token. */
  | { readonly kind: 'words'; readonly words: readonly string[] }
  | { readonly kind: 'error'; readonly error: HelpError };

export interface CompleteResult {
  /** The line with its last token completed, or undefined when no single completion exists. */
  readonly line: string | undefined;
  readonly candidates: readonly string[];
}

interface Position<Ctx> {
  readonly node: TrieNode<Ctx> | undefined;
  readonly next: readonly TrieNode<Ctx>[];
  readonly negated: boolean;
  readonly viaDo: boolean;
  /** The mode the command resolves in. It is privileged EXEC after `do`. */
  readonly scope: Mode;
  readonly args: Readonly<Record<string, unknown>>;
}

type Walk<Ctx> =
  | { readonly kind: 'ok'; readonly at: Position<Ctx> }
  | { readonly kind: 'error'; readonly error: CliError };

type Step<Ctx> =
  | {
      readonly kind: 'match';
      readonly node: TrieNode<Ctx>;
      readonly value: unknown;
      readonly next: number;
    }
  | { readonly kind: 'error'; readonly error: CliError };

const CR: HelpEntry = { name: '<cr>', help: '' };

export function tokenize(line: string): Token[] {
  return Array.from(line.matchAll(/\S+/g), (m) => ({ text: m[0], start: m.index }));
}

function rootsOf<Ctx>(tree: CommandTree<Ctx>, mode: Mode): readonly TrieNode<Ctx>[] {
  return tree.roots.get(mode.kind) ?? [];
}

function start<Ctx>(tree: CommandTree<Ctx>, mode: Mode): Position<Ctx> {
  const roots = rootsOf(tree, mode);
  const prefixes = [
    ...(roots.some((n) => n.negatable) ? [tree.noNode] : []),
    ...(isConfigMode(mode) ? [tree.doNode] : []),
  ];
  const next = [...roots, ...prefixes];
  return { node: undefined, next, negated: false, viaDo: false, scope: mode, args: {} };
}

function advance<Ctx>(
  tree: CommandTree<Ctx>,
  at: Position<Ctx>,
  node: TrieNode<Ctx>,
  value: unknown,
): Position<Ctx> {
  if (node === tree.noNode) {
    return { ...at, node, negated: true, next: rootsOf(tree, at.scope).filter((n) => n.negatable) };
  }
  if (node === tree.doNode) {
    return { ...at, node, viaDo: true, scope: PRIV_EXEC, next: rootsOf(tree, PRIV_EXEC) };
  }
  const { segment, children } = node;
  const args = segment.kind === 'param' ? { ...at.args, [segment.name]: value } : at.args;
  const next = at.negated ? children.filter((n) => n.negatable) : children;
  return { ...at, node, args, next };
}

function commonPrefixLength(a: string, b: string): number {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return i;
}

/**
 * An exact keyword wins, then a unique keyword prefix, then the first param that accepts the
 * token. The caret goes where the furthest candidate stopped matching.
 */
function step<Ctx>(
  candidates: readonly TrieNode<Ctx>[],
  line: string,
  tokens: readonly Token[],
  index: number,
  token: Token,
): Step<Ctx> {
  const text = token.text.toLowerCase();
  const keywords = candidates.flatMap((node) =>
    node.segment.kind === 'keyword' ? [{ node, word: node.segment.word }] : [],
  );
  const exact = keywords.find((k) => k.word === text);
  if (exact) return { kind: 'match', node: exact.node, value: undefined, next: index + 1 };
  const prefixed = keywords.filter((k) => k.word.startsWith(text));
  const [only] = prefixed;
  if (prefixed.length === 1 && only) {
    return { kind: 'match', node: only.node, value: undefined, next: index + 1 };
  }
  if (prefixed.length > 1) {
    const input = line.slice(0, token.start + token.text.length);
    return { kind: 'error', error: { kind: 'ambiguous', input } };
  }
  let column = token.start + Math.max(0, ...keywords.map((k) => commonPrefixLength(text, k.word)));
  let incomplete = false;
  for (const node of candidates) {
    if (node.segment.kind !== 'param') continue;
    const result = node.segment.type.match({ line, tokens, index });
    if (result.kind === 'ok')
      return { kind: 'match', node, value: result.value, next: result.next };
    if (result.kind === 'incomplete') incomplete = true;
    else column = Math.max(column, result.column);
  }
  const error: CliError = incomplete ? { kind: 'incomplete' } : { kind: 'invalid', column };
  return { kind: 'error', error };
}

function walk<Ctx>(
  tree: CommandTree<Ctx>,
  mode: Mode,
  line: string,
  tokens: readonly Token[],
): Walk<Ctx> {
  let at = start(tree, mode);
  let index = 0;
  for (let token = tokens[index]; token; token = tokens[index]) {
    const result = step(at.next, line, tokens, index, token);
    if (result.kind === 'error') return result;
    at = advance(tree, at, result.node, result.value);
    index = result.next;
  }
  return { kind: 'ok', at };
}

function terminalAt<Ctx>({ node, negated }: Position<Ctx>) {
  return negated ? node?.negation : node?.terminal;
}

export function parse<Ctx>(line: string, mode: Mode, tree: CommandTree<Ctx>): ParseResult<Ctx> {
  const tokens = tokenize(line);
  if (tokens.length === 0) return { kind: 'empty' };
  const result = walk(tree, mode, line, tokens);
  if (result.kind === 'error') return result;
  const { at } = result;
  const terminal = terminalAt(at);
  if (!terminal) return { kind: 'error', error: { kind: 'incomplete' } };
  const { negated, viaDo, scope, args } = at;
  return {
    kind: 'command',
    command: terminal.command,
    negated,
    args,
    mode: viaDo || !terminal.to ? mode : terminal.to(args, scope),
    execute: (ctx) => terminal.run?.(args, ctx, scope) ?? [],
  };
}

interface Split {
  readonly before: string;
  readonly tokens: readonly Token[];
  readonly partial: Token | undefined;
}

/** Splits off the token under the cursor. There is none when the line ends in whitespace. */
function split(line: string): Split {
  const tokens = tokenize(line);
  const last = tokens.at(-1);
  if (!last || /\s$/.test(line)) return { before: line, tokens, partial: undefined };
  return { before: line.slice(0, last.start), tokens: tokens.slice(0, -1), partial: last };
}

interface Candidate {
  readonly word: string;
  readonly keyword: boolean;
}

function candidatesFor<Ctx>(next: readonly TrieNode<Ctx>[], partial: string): Candidate[] {
  const p = partial.toLowerCase();
  return next.flatMap<Candidate>(({ segment }) => {
    if (segment.kind === 'param') {
      return segment.type.complete(partial).map((word) => ({ word, keyword: false }));
    }
    return segment.word.startsWith(p) ? [{ word: segment.word, keyword: true }] : [];
  });
}

const byName = (a: HelpEntry, b: HelpEntry) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** `line` is the text before the `?`. */
export function help<Ctx>(line: string, mode: Mode, tree: CommandTree<Ctx>): HelpResult {
  const { before, tokens, partial } = split(line);
  const result = walk(tree, mode, before, tokens);
  if (result.kind === 'error') return result;
  const { at } = result;
  if (!partial) {
    const options = at.next.flatMap(({ segment }) =>
      segment.kind === 'keyword'
        ? [{ name: segment.word, help: segment.help }]
        : segment.type.entries(segment.help),
    );
    options.sort(byName);
    if (terminalAt(at)) options.push(CR);
    return { kind: 'options', options };
  }
  const labels = at.next.flatMap(({ segment }) => {
    if (segment.kind === 'keyword') return [];
    const matched = segment.type.match({
      line,
      tokens: [...tokens, partial],
      index: tokens.length,
    });
    return matched.kind === 'ok' ? segment.type.entries(segment.help).map((e) => e.name) : [];
  });
  const words = [...candidatesFor(at.next, partial.text).map((c) => c.word), ...labels];
  if (words.length === 0) return { kind: 'error', error: { kind: 'unrecognized' } };
  return { kind: 'words', words: words.sort() };
}

/** Tab completion of the token under the cursor. */
export function complete<Ctx>(line: string, mode: Mode, tree: CommandTree<Ctx>): CompleteResult {
  const { before, tokens, partial } = split(line);
  if (!partial) return { line: undefined, candidates: [] };
  const result = walk(tree, mode, before, tokens);
  if (result.kind === 'error') return { line: undefined, candidates: [] };
  const candidates = candidatesFor(result.at.next, partial.text);
  const exact = candidates.find((c) => c.keyword && c.word === partial.text.toLowerCase());
  const pick = exact ?? (candidates.length === 1 ? candidates[0] : undefined);
  return {
    line: pick && before + pick.word + (pick.keyword ? ' ' : ''),
    candidates: candidates.map((c) => c.word),
  };
}
