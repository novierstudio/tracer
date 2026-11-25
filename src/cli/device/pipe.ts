import { formatError, formatHelp } from '../format';
import { PRIV_EXEC, type Mode } from '../modes';
import { keyword, line } from '../params';
import { complete, help, parse, type CompleteResult, type HelpResult } from '../parser';
import { buildTree, defineCommand, type CommandTree } from '../tree';

/**
 * IOS output modifiers: `show running-config | include interface`. They apply to any show
 * command, so the session reads them off the line before the command parser sees it.
 */

export type ModifierKind = 'begin' | 'exclude' | 'include' | 'section';

export interface OutputModifier {
  readonly kind: ModifierKind;
  readonly pattern: RegExp;
}

const MODIFIERS: Readonly<Record<ModifierKind, string>> = {
  begin: 'Begin with the line that matches',
  exclude: 'Exclude lines that match',
  include: 'Include lines that match',
  section: 'Filter a section of output',
};

const modifier = defineCommand<unknown>();

const MODIFIER_TREE: CommandTree<unknown> = buildTree(
  (Object.keys(MODIFIERS) as ModifierKind[]).map((kind) =>
    modifier({
      modes: [PRIV_EXEC.kind],
      path: [keyword(kind, MODIFIERS[kind]), line('regex', 'Regular Expression')],
    }),
  ),
);

/** The `?` entry a show command offers before `<cr>`. */
const MODIFIER_HELP = { name: '|', help: 'Output modifiers' } as const;

const indent = (text: string) => /^\s*/.exec(text)![0].length;

/** A line and the more-indented lines under it, as `section` keeps them. */
function sectionEnd(lines: readonly string[], start: number): number {
  const depth = indent(lines[start]!);
  let end = start + 1;
  while (end < lines.length && lines[end]!.trim() !== '' && indent(lines[end]!) > depth) end++;
  return end;
}

export function applyModifier(
  { kind, pattern }: OutputModifier,
  lines: readonly string[],
): readonly string[] {
  const matches = (text: string) => pattern.test(text);
  switch (kind) {
    case 'include':
      return lines.filter(matches);
    case 'exclude':
      return lines.filter((text) => !matches(text));
    case 'begin': {
      const first = lines.findIndex(matches);
      return first === -1 ? [] : lines.slice(first);
    }
    case 'section': {
      const kept: string[] = [];
      for (let i = 0; i < lines.length;) {
        if (!matches(lines[i]!)) {
          i++;
          continue;
        }
        const end = sectionEnd(lines, i);
        kept.push(...lines.slice(i, end));
        i = end;
      }
      return kept;
    }
  }
}

export type PipedLine =
  /** No modifier: run the line as typed. */
  | { readonly kind: 'none' }
  /** Run `command`, then filter its output through `modifier`. */
  | { readonly kind: 'piped'; readonly command: string; readonly modifier: OutputModifier }
  /** The modifier is malformed. Print `output` and run nothing. */
  | { readonly kind: 'error'; readonly output: readonly string[] };

interface Split {
  readonly command: string;
  /** The text after the `|`, and the column it starts at. */
  readonly rest: string;
  readonly offset: number;
}

const isShow = (command: string) => command.split(' ')[0] === 'show';

/**
 * Splits `line` at its first `|` when the text before it is a whole show command. Anything else,
 * such as `description a|b`, is not a pipe.
 */
function split<Ctx>(line: string, mode: Mode, tree: CommandTree<Ctx>): Split | undefined {
  const bar = line.indexOf('|');
  if (bar === -1) return undefined;
  const command = line.slice(0, bar);
  const parsed = parse(command, mode, tree);
  if (parsed.kind !== 'command' || !isShow(parsed.command)) return undefined;
  return { command, rest: line.slice(bar + 1), offset: bar + 1 };
}

const INVALID_REGEX = ['% Invalid regular expression'];

export function readPipe<Ctx>(
  line: string,
  mode: Mode,
  tree: CommandTree<Ctx>,
  promptWidth: number,
): PipedLine {
  const piped = split(line, mode, tree);
  if (!piped) return { kind: 'none' };
  const parsed = parse(piped.rest, PRIV_EXEC, MODIFIER_TREE);
  if (parsed.kind === 'command') {
    try {
      const pattern = new RegExp(parsed.args.regex as string);
      const modifier = { kind: parsed.command as ModifierKind, pattern };
      return { kind: 'piped', command: piped.command, modifier };
    } catch {
      return { kind: 'error', output: INVALID_REGEX };
    }
  }
  const error = parsed.kind === 'error' ? parsed.error : ({ kind: 'incomplete' } as const);
  return { kind: 'error', output: formatError(error, promptWidth + piped.offset) };
}

/**
 * `?` help for a line. After a `|` it lists the modifiers; at the end of a show command it adds
 * the `|` entry. Undefined when the line is not a show command.
 */
export function pipeHelp<Ctx>(
  line: string,
  mode: Mode,
  tree: CommandTree<Ctx>,
  promptWidth: number,
): readonly string[] | undefined {
  const piped = split(line, mode, tree);
  if (piped) {
    return formatHelp(help(piped.rest, PRIV_EXEC, MODIFIER_TREE), promptWidth + piped.offset);
  }
  const result = help(line, mode, tree);
  if (!/\s$/.test(line) || result.kind !== 'options') return undefined;
  const parsed = parse(line, mode, tree);
  if (parsed.kind !== 'command' || !isShow(parsed.command)) return undefined;
  const options = [...result.options];
  options.splice(options.length - 1, 0, MODIFIER_HELP);
  return formatHelp({ kind: 'options', options } satisfies HelpResult, promptWidth);
}

/** Tab completion of a modifier word after a `|`. Undefined when the line has no pipe. */
export function pipeComplete<Ctx>(
  line: string,
  mode: Mode,
  tree: CommandTree<Ctx>,
): CompleteResult | undefined {
  const piped = split(line, mode, tree);
  if (!piped) return undefined;
  const result = complete(piped.rest, PRIV_EXEC, MODIFIER_TREE);
  return { ...result, line: result.line && `${piped.command}|${result.line}` };
}
