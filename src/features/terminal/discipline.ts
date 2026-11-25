import type { TerminalSession } from './session';

/**
 * The line discipline between xterm and a CLI session: it turns raw terminal input into line
 * edits, runs whole lines, and returns the bytes to write back. It owns no I/O.
 */

type Action =
  | 'enter'
  | 'backspace'
  | 'delete'
  | 'left'
  | 'right'
  | 'home'
  | 'end'
  | 'up'
  | 'down'
  | 'tab'
  | 'help'
  | 'kill-start'
  | 'kill-end'
  | 'kill-word'
  | 'interrupt'
  | 'end-config';

export type Key = { readonly kind: 'text'; readonly text: string } | { readonly kind: Action };

export type Input = Key | { readonly kind: 'resize'; readonly cols: number; readonly rows: number };

export interface LineState {
  readonly line: string;
  readonly cursor: number;
  readonly history: readonly string[];
  /** Set while Up/Down walk the history. `draft` is the line typed before the walk began. */
  readonly recall: { readonly index: number; readonly draft: string } | undefined;
  readonly cols: number;
  readonly rows: number;
  /** Output still to show after a `--More--` prompt. */
  readonly more: readonly string[] | undefined;
}

export interface Step {
  readonly state: LineState;
  readonly out: string;
}

const HISTORY_SIZE = 50;
const MORE = ' --More-- ';
const BELL = '\x07';
const CSI = '\x1b[';

// IOS editing keys. xterm sends DEL for Backspace.
const CONTROL: Readonly<Record<string, Action>> = {
  '\r': 'enter',
  '\n': 'enter',
  '\x7f': 'backspace',
  '\b': 'backspace',
  '\t': 'tab',
  '?': 'help',
  '\x01': 'home',
  '\x05': 'end',
  '\x02': 'left',
  '\x06': 'right',
  '\x10': 'up',
  '\x0e': 'down',
  '\x04': 'delete',
  '\x15': 'kill-start',
  '\x18': 'kill-start',
  '\x0b': 'kill-end',
  '\x17': 'kill-word',
  '\x03': 'interrupt',
  '\x1a': 'end-config',
};

const ESCAPES: Readonly<Record<string, Action>> = {
  A: 'up',
  B: 'down',
  C: 'right',
  D: 'left',
  H: 'home',
  F: 'end',
  '1~': 'home',
  '7~': 'home',
  '4~': 'end',
  '8~': 'end',
  '3~': 'delete',
};

/** Splits terminal input into keys. A paste arrives as one chunk and becomes a key sequence. */
export function decode(data: string): Key[] {
  const keys: Key[] = [];
  let text = '';
  const flush = () => {
    if (text) keys.push({ kind: 'text', text });
    text = '';
  };
  for (let i = 0; i < data.length; i++) {
    const ch = data[i]!;
    if (ch === '\x1b') {
      flush();
      const match = /^(?:\[([\d;]*)([A-Za-z~])|O([A-Za-z]))?/.exec(data.slice(i + 1))!;
      const [sequence, params = '', final, ss3] = match;
      const action = ESCAPES[ss3 ?? (final === '~' ? `${params}~` : (final ?? ''))];
      if (action) keys.push({ kind: action });
      i += sequence.length;
      continue;
    }
    const action = CONTROL[ch];
    if (action) {
      flush();
      if (action === 'enter' && ch === '\n' && data[i - 1] === '\r') continue;
      keys.push({ kind: action });
    } else if (ch >= ' ') {
      text += ch;
    }
  }
  flush();
  return keys;
}

export function initialState(cols: number, rows: number): LineState {
  return { line: '', cursor: 0, history: [], recall: undefined, cols, rows, more: undefined };
}

const up = (n: number) => (n > 0 ? `${CSI}${n}A` : '');
const down = (n: number) => (n > 0 ? `${CSI}${n}B` : '');
const right = (n: number) => (n > 0 ? `${CSI}${n}C` : '');

/** Where the cursor sits, counted from the first column of the prompt's row. */
function offset(session: TerminalSession, state: LineState, cursor = state.cursor): number {
  return session.prompt.length + cursor;
}

// Writing up to the last column leaves xterm waiting to wrap. Stepping to the next row keeps
// the cursor at row = offset / cols, which every movement below relies on.
function settle(end: number, cols: number): string {
  return end > 0 && end % cols === 0 ? '\r\n' : '';
}

/** Draws the prompt and line on a fresh row, then puts the cursor back in place. */
function draw(session: TerminalSession, state: LineState): string {
  const { cols } = state;
  const end = offset(session, state, state.line.length);
  const at = offset(session, state);
  const rowsUp = Math.floor(end / cols) - Math.floor(at / cols);
  return `${session.prompt}${state.line}${settle(end, cols)}${up(rowsUp)}\r${right(at % cols)}`;
}

/** Redraws the line in place after an edit. `from` is the cursor before the edit. */
function redraw(session: TerminalSession, from: number, state: LineState): string {
  return `${up(Math.floor(from / state.cols))}\r${CSI}J${draw(session, state)}`;
}

/** Moves the cursor within the line without rewriting it. */
function move(from: number, to: number, cols: number): string {
  const rows = Math.floor(to / cols) - Math.floor(from / cols);
  return `${rows < 0 ? up(-rows) : down(rows)}\r${right(to % cols)}`;
}

/** Writes `echo` after the line, then moves to a fresh row for output. */
function leave(session: TerminalSession, state: LineState, echo = ''): string {
  const end = offset(session, state, state.line.length);
  // When the line fills its last row exactly, the cursor already sits on an empty row.
  const fresh = end > 0 && end % state.cols === 0;
  return move(offset(session, state), end, state.cols) + echo + (fresh && !echo ? '' : '\r\n');
}

function lines(output: readonly string[]): string {
  return output.map((l) => `${l}\r\n`).join('');
}

/** Prints output a page at a time, then the prompt and whatever line is left in `state`. */
function show(session: TerminalSession, state: LineState, output: readonly string[]): Step {
  const page = Math.max(1, state.rows - 1);
  if (output.length <= page) {
    return { state: { ...state, more: undefined }, out: lines(output) + draw(session, state) };
  }
  return {
    state: { ...state, more: output.slice(page) },
    out: lines(output.slice(0, page)) + MORE,
  };
}

function page(session: TerminalSession, state: LineState, key: Key): Step {
  const more = state.more ?? [];
  const erase = `\r${CSI}K`;
  if (key.kind === 'text' && key.text.startsWith(' ')) {
    const next = show(session, state, more);
    return { state: next.state, out: erase + next.out };
  }
  if (key.kind === 'enter') {
    const [first = '', ...rest] = more;
    const out = `${erase}${first}\r\n`;
    if (rest.length > 0) return { state: { ...state, more: rest }, out: out + MORE };
    return { state: { ...state, more: undefined }, out: out + draw(session, state) };
  }
  return { state: { ...state, more: undefined }, out: erase + draw(session, state) };
}

function edit(session: TerminalSession, state: LineState, line: string, cursor: number): Step {
  const next = { ...state, line, cursor, recall: undefined };
  return { state: next, out: redraw(session, offset(session, state), next) };
}

function moveTo(session: TerminalSession, state: LineState, cursor: number): Step {
  if (cursor === state.cursor) return { state, out: '' };
  const out = move(offset(session, state), offset(session, state, cursor), state.cols);
  return { state: { ...state, cursor }, out };
}

function insert(session: TerminalSession, state: LineState, text: string): Step {
  const { line, cursor } = state;
  const next = {
    ...state,
    line: line.slice(0, cursor) + text + line.slice(cursor),
    cursor: cursor + text.length,
    recall: undefined,
  };
  if (cursor < line.length)
    return { state: next, out: redraw(session, offset(session, state), next) };
  // Typing at the end only echoes, so a screen reader hears the new characters, not the line.
  return { state: next, out: text + settle(offset(session, next), state.cols) };
}

function recall(session: TerminalSession, state: LineState, delta: -1 | 1): Step {
  const { history } = state;
  const index = (state.recall?.index ?? history.length) + delta;
  if (index < 0 || (index > history.length - 1 && !state.recall)) return { state, out: BELL };
  const draft = state.recall?.draft ?? state.line;
  const line = index >= history.length ? draft : history[index]!;
  const next = {
    ...state,
    line,
    cursor: line.length,
    recall: index >= history.length ? undefined : { index, draft },
  };
  return { state: next, out: redraw(session, offset(session, state), next) };
}

function wordStart(line: string, cursor: number): number {
  return line.slice(0, cursor).replace(/\S*\s*$/, '').length;
}

function remember(history: readonly string[], line: string): readonly string[] {
  if (!line.trim() || history.at(-1) === line) return history;
  return [...history, line].slice(-HISTORY_SIZE);
}

/** Runs the line, or ends config mode, and starts a fresh line after its output. */
function submit(
  session: TerminalSession,
  state: LineState,
  echo: string,
  run: () => readonly string[],
): Step {
  const head = leave(session, state, echo);
  const cleared = { ...state, line: '', cursor: 0, recall: undefined };
  const next = show(session, cleared, run());
  return { state: next.state, out: head + next.out };
}

export function reduce(state: LineState, input: Input, session: TerminalSession): Step {
  if (input.kind === 'resize') {
    return { state: { ...state, cols: input.cols, rows: input.rows }, out: '' };
  }
  if (state.more) return page(session, state, input);
  const { line, cursor } = state;
  switch (input.kind) {
    case 'text':
      return insert(session, state, input.text);
    case 'backspace':
      if (cursor === 0) return { state, out: BELL };
      if (cursor === line.length && offset(session, state) % state.cols !== 0) {
        const next = { ...state, line: line.slice(0, -1), cursor: cursor - 1, recall: undefined };
        return { state: next, out: `\b${CSI}K` };
      }
      return edit(session, state, line.slice(0, cursor - 1) + line.slice(cursor), cursor - 1);
    case 'delete':
      if (cursor === line.length) return { state, out: BELL };
      return edit(session, state, line.slice(0, cursor) + line.slice(cursor + 1), cursor);
    case 'left':
      return moveTo(session, state, Math.max(0, cursor - 1));
    case 'right':
      return moveTo(session, state, Math.min(line.length, cursor + 1));
    case 'home':
      return moveTo(session, state, 0);
    case 'end':
      return moveTo(session, state, line.length);
    case 'kill-start':
      return edit(session, state, line.slice(cursor), 0);
    case 'kill-end':
      return edit(session, state, line.slice(0, cursor), cursor);
    case 'kill-word': {
      const at = wordStart(line, cursor);
      return edit(session, state, line.slice(0, at) + line.slice(cursor), at);
    }
    case 'up':
      return recall(session, state, -1);
    case 'down':
      return recall(session, state, 1);
    case 'tab': {
      const result = session.complete(line.slice(0, cursor));
      if (result.line !== undefined) {
        return edit(session, state, result.line + line.slice(cursor), result.line.length);
      }
      if (result.candidates.length < 2) return { state, out: BELL };
      const listed = `${leave(session, state)}${result.candidates.join('  ')}\r\n`;
      return { state, out: listed + draw(session, state) };
    }
    case 'help': {
      // IOS echoes the `?` but keeps it out of the line, then redraws the line under the help.
      const echo = cursor === line.length ? '?' : '';
      const next = show(session, state, session.help(line.slice(0, cursor)));
      return { state: next.state, out: leave(session, state, echo) + next.out };
    }
    case 'enter': {
      const ran = { ...state, history: remember(state.history, line) };
      return submit(session, ran, '', () => session.run(line));
    }
    case 'interrupt':
      return submit(session, state, '^C', () => []);
    case 'end-config':
      return submit(session, state, '^Z', () => session.end());
  }
}

/** Decodes a chunk of terminal input and applies every key in order. */
export function feed(state: LineState, data: string, session: TerminalSession): Step {
  let out = '';
  for (const key of decode(data)) {
    const step = reduce(state, key, session);
    state = step.state;
    out += step.out;
  }
  return { state, out };
}
