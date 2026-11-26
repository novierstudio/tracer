import type { OutputStream } from '@/cli';
import {
  decode,
  feed,
  initialState,
  interject,
  reduce,
  type Input,
  type LineState,
} from './discipline';
import { isStream, type TerminalSession } from './session';

/** Characters of output kept for replay, about the 5000 rows xterm keeps as scrollback. */
export const TRANSCRIPT_LIMIT = 512 * 1024;

export type Size = { readonly cols: number; readonly rows: number };

/**
 * A terminal without a screen: the session, its line editor and everything it has printed. Views
 * come and go; a view that mounts later replays `transcript`, and every view sees new output.
 */
export interface Tty {
  readonly session: TerminalSession;
  /** Everything written so far, trimmed at a line break to `TRANSCRIPT_LIMIT`. */
  readonly transcript: string;
  readonly history: LineState['history'];
  /** Keys typed into a view of `size`. The view that typed sets the geometry. */
  input(data: string, size: Size): void;
  /** Prints messages the device logs on its own, such as `%LINK-3-UPDOWN`, between lines typed. */
  log(lines: readonly string[]): void;
  /** Calls `write` with each chunk of new output until the returned function is called. */
  subscribe(write: (out: string) => void): () => void;
}

/** Ctrl+C, and Ctrl+Shift+6, the IOS escape sequence. Either aborts a streaming command. */
const ABORT_KEYS = ['\x03', '\x1e'];
const hasAbortKey = (data: string) => ABORT_KEYS.some((key) => data.includes(key));
const withoutAbortKeys = (data: string) =>
  [...data].filter((key) => !ABORT_KEYS.includes(key)).join('');

export function trimTranscript(transcript: string): string {
  if (transcript.length <= TRANSCRIPT_LIMIT) return transcript;
  const cut = transcript.indexOf('\r\n', transcript.length - TRANSCRIPT_LIMIT);
  return cut === -1 ? transcript.slice(-TRANSCRIPT_LIMIT) : transcript.slice(cut + 2);
}

export function createTty(session: TerminalSession, greeting: readonly string[] = []): Tty {
  let line = initialState(80, 24);
  let transcript = greeting.map((text) => `${text}\r\n`).join('') + session.prompt;
  const views = new Set<(out: string) => void>();
  /** Input that arrived while a line waits on its output. It runs once the output is shown. */
  let held: Input[] | undefined;
  /** The stream writing a line's output now, such as a ping. */
  let streaming: OutputStream | undefined;

  const write = (out: string) => {
    if (!out) return;
    transcript = trimTranscript(transcript + out);
    for (const view of views) view(out);
  };

  const run = (inputs: string | readonly Input[]) => {
    const step = feed(line, inputs, session);
    line = step.state;
    write(step.out);
    if (!step.pending) return;
    held = [...step.rest];
    const { pending } = step;
    const output = isStream(pending) ? stream(pending) : pending.catch(() => []);
    void output.then((lines) => {
      const queued = held ?? [];
      held = undefined;
      run([{ kind: 'output', lines }, ...queued]);
    });
  };

  /** Writes the stream's pieces as they come, and gives no lines to print after them. */
  const stream = (output: OutputStream): Promise<readonly string[]> => {
    streaming = output;
    return output
      .start((text) => write(text.replaceAll('\n', '\r\n')))
      .catch(() => {})
      .then(() => {
        streaming = undefined;
        return [];
      });
  };

  return {
    session,
    get transcript() {
      return transcript;
    },
    get history() {
      return line.history;
    },
    input(data, { cols, rows }) {
      if (cols !== line.cols || rows !== line.rows) {
        line = reduce(line, { kind: 'resize', cols, rows }, session).state;
      }
      if (!held) return run(data);
      // IOS reads the escape sequence during a ping; other keys wait for the prompt.
      if (streaming && hasAbortKey(data)) {
        streaming.abort();
        held.push(...decode(withoutAbortKeys(data)));
      } else {
        held.push(...decode(data));
      }
    },
    log(lines) {
      // While a command's output or a --More-- page is on screen, the message follows it as is.
      if (held || line.more) write(lines.map((text) => `\r\n${text}`).join('') + '\r\n');
      else write(interject(session, line, lines));
    },
    subscribe(write) {
      views.add(write);
      return () => {
        views.delete(write);
      };
    },
  };
}
