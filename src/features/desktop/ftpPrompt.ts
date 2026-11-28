import type { OutputStream } from '@/cli';
import type { TerminalSession } from '@/features/terminal/session';
import type { Ipv4Address, StoredFile } from '@/model';
import type { FtpFailure, FtpOutcome, FtpReply, FtpSession } from './backend';
import { byteLength } from './files';

/** Where the session is: logging in, or at `ftp>`. */
type Step = 'username' | 'password' | 'command' | 'closed';

const PROMPTS: Record<Step, string> = {
  username: 'Username:',
  password: 'Password:',
  command: 'ftp>',
  closed: '',
};

/** The commands `?` and `help` list, as Packet Tracer names them. */
export const FTP_HELP = ['delete', 'dir', 'get', 'help', 'put', 'quit', 'rename'];

/** `ftp` words why a session did not open: the server never answered, or turned it away. */
export const FTP_FAILURE: Record<FtpFailure, string> = {
  timeout: 'Timed out',
  refused: 'Connection refused',
  reset: 'Connection reset',
  cancelled: 'Cancelled',
};

/** A reply as Packet Tracer's client prints it: `331- Username ok, need password`. */
export const replyLine = ({ code, text }: FtpReply) => `${code}- ${text}`;

/** `26 bytes copied in 0.08 secs (325 bytes/sec)`, timed on the simulated clock. */
function transferred(bytes: number, elapsedMs: number): string {
  // The clock reaches the client in batches, so a quick transfer can read as no time at all.
  const ms = Math.max(1, elapsedMs);
  const rate = Math.floor((bytes * 1000) / ms);
  return `\n[Transfer complete - ${bytes} bytes]\n\n${bytes} bytes copied in ${ms / 1000} secs (${rate} bytes/sec)\n`;
}

/** What the client prints when the server refuses a file action. */
const refusal = (server: Ipv4Address, file: string) => [
  `%Error ftp://${server}/${file} (No such file or directory Or Permission denied)`,
  '550-Requested action not taken. permission denied).',
];

export type FtpPromptContext = {
  readonly server: Ipv4Address;
  readonly session: FtpSession;
  /** The host's disk now, which `put` reads. */
  files(): readonly StoredFile[];
  /** Keeps a file `get` fetched on the host's disk. */
  save(file: StoredFile): void;
};

/** The `ftp>` prompt as a terminal session the Command Prompt hands the keyboard to. */
export interface FtpPrompt {
  readonly terminal: TerminalSession;
  /** Resolves once the session has ended and its last words are printed. */
  readonly done: Promise<void>;
  /**
   * Takes the function that prints lines between typed ones. A rename or delete gives the prompt
   * back at once and prints its result with it when the server answers.
   */
  onLog(log: (lines: readonly string[]) => void): void;
}

/**
 * Packet Tracer's FTP client: asks for a user name and a password, then runs `put`, `get`, `dir`,
 * `rename`, `delete` and `quit` on the session, one request at a time.
 */
export function ftpPrompt({ server, session, files, save }: FtpPromptContext): FtpPrompt {
  let step: Step = 'username';
  let log: (lines: readonly string[]) => void = () => {};
  /** The reply being printed now, which the session's last words wait for. */
  let printing: Promise<unknown> = Promise.resolve();
  void session.closed.then(() => (step = 'closed'));

  /** Output that arrives a piece at a time: `run` writes, and the prompt comes back after it. */
  const stream = (run: (write: (text: string) => void) => Promise<void>): OutputStream => ({
    start(write) {
      const output = run(write);
      printing = output;
      return output;
    },
    abort() {},
  });

  /** Sends `request` and prints what `print` makes of its outcome, unless the session ended. */
  const reply = async (
    request: Parameters<FtpSession['send']>[0],
    print: (outcome: FtpOutcome) => readonly string[],
  ) => {
    const outcome = await session.send(request);
    return outcome ? print(outcome) : [];
  };

  const track = <T>(output: Promise<T>) => {
    printing = output;
    return output;
  };

  const login = (line: string): Promise<readonly string[]> => {
    if (step === 'username') {
      step = 'password';
      return track(reply({ kind: 'user', name: line }, ({ result }) => [replyLine(result.reply)]));
    }
    return track(
      reply({ kind: 'pass', password: line }, ({ result }) => {
        if (result.reply.code === 230) {
          step = 'command';
          return [replyLine(result.reply), '(passive mode On)'];
        }
        session.close();
        return [replyLine(result.reply)];
      }),
    );
  };

  const transfer = (verb: 'put' | 'get', file: string | undefined) => {
    if (file === undefined) return [`Usage: ${verb} filename`];
    if (verb === 'put') {
      const local = files().find((candidate) => candidate.name === file);
      if (!local) return [`%Error opening ${file} (No such file or directory)`];
      return stream(async (write) => {
        write(`\nWriting file ${file} to ${server}: \nFile transfer in progress...\n`);
        const outcome = await session.send({ kind: 'put', file, content: local.content });
        if (!outcome) return;
        if (outcome.result.reply.code !== 226)
          return write(`\n${refusal(server, file).join('\n')}\n`);
        write(transferred(byteLength(local.content), outcome.elapsedMs));
      });
    }
    return stream(async (write) => {
      write(`\nReading file ${file} from ${server}: \nFile transfer in progress...\n`);
      const outcome = await session.send({ kind: 'get', file });
      if (!outcome) return;
      const { content } = outcome.result;
      if (outcome.result.reply.code !== 226 || content === undefined) {
        return write(`\n${refusal(server, file).join('\n')}\n`);
      }
      save({ name: file, content });
      write(transferred(byteLength(content), outcome.elapsedMs));
    });
  };

  const list = () =>
    stream(async (write) => {
      write(`\nListing /ftp directory from ${server}: \n`);
      const outcome = await session.send({ kind: 'list' });
      if (!outcome) return;
      const { listing } = outcome.result;
      if (outcome.result.reply.code !== 226 || !listing) {
        return write(`${refusal(server, '').join('\n')}\n`);
      }
      const rows = listing.map(
        ({ name, size }, at) => `${String(at).padEnd(4)}: ${name.padEnd(51)}${size}\n`,
      );
      write(rows.join(''));
    });

  const command = (line: string) => {
    const [verb, ...args] = line.trim().split(/\s+/).filter(Boolean);
    switch (verb?.toLowerCase()) {
      case undefined:
        return [];
      case 'help':
        return FTP_HELP;
      case 'put':
      case 'get':
        return transfer(verb.toLowerCase() as 'put' | 'get', args[0]);
      case 'dir':
        return list();
      case 'rename': {
        const [from, to] = args;
        if (from === undefined || to === undefined) return ['Usage: rename oldname newname'];
        void session.send({ kind: 'rename', from, to }).then((outcome) => {
          if (!outcome) return;
          log(
            outcome.result.reply.code === 250
              ? [`[OK Renamed file successfully from ${from} to ${to}]`]
              : refusal(server, from),
          );
        });
        return ['', `Renaming ${from}`];
      }
      case 'delete': {
        const [file] = args;
        if (file === undefined) return ['Usage: delete filename'];
        void session.send({ kind: 'delete', file }).then((outcome) => {
          if (!outcome) return;
          log(
            outcome.result.reply.code === 250
              ? [`[Deleted file ${file} successfully ]`]
              : refusal(server, file),
          );
        });
        // Packet Tracer gives the prompt back on the same line, and the result follows it.
        return stream(async (write) => write(`\nDeleting file ${file} from ${server}: `));
      }
      case 'quit':
        return stream(async (write) => {
          const outcome = await session.send({ kind: 'quit' });
          write(`\n${outcome ? replyLine(outcome.result.reply) : ''}\n`);
          session.close();
        });
      default:
        return ['Invalid or non supported command.'];
    }
  };

  const terminal: TerminalSession = {
    get prompt() {
      return PROMPTS[step];
    },
    get masked() {
      return step === 'password';
    },
    run(line) {
      if (step === 'closed') return [];
      return step === 'command' ? command(line) : login(line);
    },
    // `?` on an empty line lists the commands; cmd has no completion.
    help: (line) => (step === 'command' && line.trim() === '' ? FTP_HELP : []),
    complete: () => ({ line: undefined, candidates: [] }),
    end: () => [],
  };

  return {
    terminal,
    done: session.closed.then(() => printing.then(() => {})),
    onLog(next) {
      log = next;
    },
  };
}
