import type { Mode, ModeKind, ModeOf } from './modes';
import { keyword, type Param, type Segment } from './params';

type ValueOf<S> = S extends Param<string, infer T> ? T : never;

export type ArgsOf<P extends readonly Segment[]> = {
  readonly [
    S in P[number] as S extends Param<infer N extends string, unknown> ? N : never
  ]: ValueOf<S>;
};

export interface CommandSpec<Ctx, M extends readonly ModeKind[], P extends readonly Segment[]> {
  readonly modes: M;
  readonly path: P;
  /** The mode after the command. Omitted means the mode does not change. */
  readonly to?: Mode | ((args: ArgsOf<P>, from: ModeOf<M[number]>) => Mode);
  readonly run?: (args: ArgsOf<P>, ctx: Ctx, mode: ModeOf<M[number]>) => readonly string[];
  /**
   * The `no` form. It is accepted after the last keyword of `path` or after any later param, so
   * `no ip address` and `no ip address 10.0.0.1 255.0.0.0` both reach it.
   */
  readonly no?: (args: Partial<ArgsOf<P>>, ctx: Ctx, mode: ModeOf<M[number]>) => readonly string[];
}

type Args = Readonly<Record<string, unknown>>;

export interface Terminal<Ctx> {
  /** The command's keywords joined by spaces, such as `ip address`. */
  readonly command: string;
  readonly to?: (args: Args, from: Mode) => Mode;
  readonly run?: (args: Args, ctx: Ctx, mode: Mode) => readonly string[];
}

export interface Command<Ctx> {
  readonly modes: readonly ModeKind[];
  readonly path: readonly Segment[];
  readonly terminal: Terminal<Ctx>;
  readonly negation: Terminal<Ctx> | undefined;
}

/** Returns a `command` builder whose handlers receive a `Ctx`. */
export function defineCommand<Ctx>() {
  return <const M extends readonly ModeKind[], const P extends readonly Segment[]>(
    spec: CommandSpec<Ctx, M, P>,
  ): Command<Ctx> => {
    const { modes, path, to, run, no } = spec;
    if (path.length === 0) throw new Error('A command needs at least one segment.');
    const rest = path.findIndex((s) => s.kind === 'param' && s.type.restOfLine);
    if (rest !== -1 && rest !== path.length - 1) {
      throw new Error('A param that takes the rest of the line must end its command.');
    }
    const command = path.flatMap((s) => (s.kind === 'keyword' ? [s.word] : [])).join(' ');
    return {
      modes,
      path,
      terminal: {
        command,
        run: run as Terminal<Ctx>['run'],
        to: typeof to === 'function' ? (to as Terminal<Ctx>['to']) : to && (() => to),
      },
      negation: no && { command, run: no as Terminal<Ctx>['run'] },
    };
  };
}

export interface TrieNode<Ctx> {
  readonly segment: Segment;
  readonly children: TrieNode<Ctx>[];
  terminal: Terminal<Ctx> | undefined;
  negation: Terminal<Ctx> | undefined;
  /** Some `no` form passes through this node. */
  negatable: boolean;
}

export interface CommandTree<Ctx> {
  readonly roots: ReadonlyMap<ModeKind, readonly TrieNode<Ctx>[]>;
  readonly noNode: TrieNode<Ctx>;
  readonly doNode: TrieNode<Ctx>;
}

function node<Ctx>(segment: Segment): TrieNode<Ctx> {
  return { segment, children: [], terminal: undefined, negation: undefined, negatable: false };
}

function sameSegment(a: Segment, b: Segment): boolean {
  if (a.kind === 'keyword') return b.kind === 'keyword' && a.word === b.word;
  return b.kind === 'param' && a.name === b.name && a.type.id === b.type.id;
}

function childFor<Ctx>(level: TrieNode<Ctx>[], segment: Segment): TrieNode<Ctx> {
  const existing = level.find((n) => sameSegment(n.segment, segment));
  if (existing) return existing;
  const created = node<Ctx>(segment);
  level.push(created);
  return created;
}

export function buildTree<Ctx>(commands: readonly Command<Ctx>[]): CommandTree<Ctx> {
  const roots = new Map<ModeKind, TrieNode<Ctx>[]>();
  for (const { modes, path, terminal, negation } of commands) {
    const lastKeyword = path.findLastIndex((s) => s.kind === 'keyword');
    for (const mode of modes) {
      let level = roots.get(mode);
      if (!level) roots.set(mode, (level = []));
      let current: TrieNode<Ctx> | undefined;
      for (const [i, segment] of path.entries()) {
        current = childFor(level, segment);
        level = current.children;
        if (!negation) continue;
        current.negatable = true;
        // The first command to claim a `no` stop keeps it.
        if (i >= lastKeyword) current.negation ??= negation;
      }
      if (!current) continue;
      if (current.terminal) throw new Error(`Duplicate command "${terminal.command}" in ${mode}.`);
      current.terminal = terminal;
    }
  }
  return {
    roots,
    noNode: node(keyword('no', 'Negate a command or set its defaults')),
    doNode: node(keyword('do', 'To run exec commands in config mode')),
  };
}
