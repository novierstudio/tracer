import {
  decode,
  initialState,
  reduce,
  type Key,
  type LineState,
} from '@/features/terminal/discipline';
import type { TerminalSession } from '@/features/terminal/session';
import { createTty, trimTranscript, type Tty } from '@/features/terminal/tty';
import type { HostShell, ShellIo } from './shell';

export const PROMPT = 'C:\\>';
export const GREETING = ['Tracer Command Prompt', 'Type help to see the commands.', ''];

const CLEAR = '\x1b[H\x1b[2J\x1b[3J';

/** A Tty that can be stopped mid-command, so a view can tell when to stop the host. */
export interface HostTty extends Tty {
  /** Ctrl+C for whatever is running. The device went away, say. */
  stop(): void;
}

/**
 * The Command Prompt's terminal. Lines go through the IOS line discipline for editing and
 * history; a submitted line runs as a job whose output streams in, with the prompt hidden until
 * it ends. While a job runs, only Ctrl+C does anything.
 */
export function createHostTty(shell: HostShell): HostTty {
  let line: LineState = initialState(80, 24);
  let transcript = GREETING.map((text) => `${text}\r\n`).join('') + PROMPT;
  let job: AbortController | undefined;
  /** A Telnet, SSH or FTP session the running job handed the keyboard to. */
  let attached: { tty: Tty; interruptible: boolean } | undefined;
  const views = new Set<(out: string) => void>();

  const write = (out: string) => {
    if (!out) return;
    transcript = trimTranscript(transcript + out);
    for (const view of views) view(out);
  };

  const start = (text: string) => {
    const controller = new AbortController();
    job = controller;
    const io: ShellIo = {
      signal: controller.signal,
      print: (lines) => {
        if (job === controller) write(lines.map((l) => `${l}\r\n`).join(''));
      },
      write: (text) => {
        if (job === controller) write(text.replaceAll('\n', '\r\n'));
      },
      clear: () => {
        if (job !== controller) return;
        transcript = '';
        for (const view of views) view(CLEAR);
      },
      attach: (remote, done, { interruptible = false, onLog } = {}) => {
        if (job !== controller) return Promise.resolve();
        const inner = createTty(remote);
        write(inner.transcript);
        const unsubscribe = inner.subscribe(write);
        const current = { tty: inner, interruptible };
        attached = current;
        onLog?.((lines) => {
          if (attached === current) inner.log(lines);
        });
        return done.finally(() => {
          unsubscribe();
          if (attached === current) attached = undefined;
        });
      },
    };
    // After this tick, so the discipline's echo of the line lands before any output.
    void Promise.resolve()
      .then(() => shell(text, io))
      .finally(() => {
        if (job !== controller) return;
        job = undefined;
        write(PROMPT);
      });
  };

  // The discipline draws `prompt` after a line runs: empty while the job it started is running.
  const session: TerminalSession = {
    get prompt() {
      return job ? '' : PROMPT;
    },
    masked: false,
    run(text) {
      start(text);
      return [];
    },
    help: () => [],
    complete: () => ({ line: undefined, candidates: [] }),
    end: () => [],
  };

  const press = (key: Key) => {
    if (job) {
      if (key.kind === 'interrupt') job.abort();
      return;
    }
    // `?` is just a character in cmd; the discipline treats it as IOS help.
    const step = reduce(line, key.kind === 'help' ? { kind: 'text', text: '?' } : key, session);
    line = step.state;
    write(step.out);
  };

  return {
    session,
    // A host logs nothing on its own.
    log: () => {},
    get transcript() {
      return transcript;
    },
    get history() {
      return line.history;
    },
    input(data, { cols, rows }) {
      if (attached?.interruptible && data.includes('\x03')) return job?.abort();
      if (attached) return attached.tty.input(data, { cols, rows });
      if (cols !== line.cols || rows !== line.rows) {
        line = reduce(line, { kind: 'resize', cols, rows }, session).state;
      }
      for (const key of decode(data)) press(key);
    },
    subscribe(view) {
      views.add(view);
      return () => {
        views.delete(view);
      };
    },
    stop() {
      job?.abort();
    },
  };
}
