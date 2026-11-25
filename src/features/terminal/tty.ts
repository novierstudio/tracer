import { decode, feed, initialState, reduce, type Input, type LineState } from './discipline';
import type { TerminalSession } from './session';

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
  /** Calls `write` with each chunk of new output until the returned function is called. */
  subscribe(write: (out: string) => void): () => void;
}

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
    void step.pending
      .catch(() => [])
      .then((lines) => {
        const queued = held ?? [];
        held = undefined;
        run([{ kind: 'output', lines }, ...queued]);
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
      if (held) held.push(...decode(data));
      else run(data);
    },
    subscribe(write) {
      views.add(write);
      return () => {
        views.delete(write);
      };
    },
  };
}
