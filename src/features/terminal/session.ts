import {
  complete,
  endMode,
  formatError,
  formatHelp,
  help,
  parse,
  prompt,
  USER_EXEC,
  type CompleteResult,
  type Mode,
} from '@/cli';
import { DEFAULT_HOSTNAME, demoTree, type DemoContext } from '@/cli/commands/demo';

/** One CLI connection: lines in, output lines and a prompt out. It owns the mode. */
export interface TerminalSession {
  readonly prompt: string;
  run(line: string): readonly string[];
  /** `?` help for the text before the cursor. */
  help(line: string): readonly string[];
  complete(line: string): CompleteResult;
  /** Ctrl+Z: leave config mode for privileged EXEC. */
  end(): readonly string[];
}

/** A stand-in router on the demo command set until devices own their CLI. */
export function createDemoSession(): TerminalSession {
  let hostname = DEFAULT_HOSTNAME;
  let mode: Mode = USER_EXEC;
  const ctx: DemoContext = {
    get hostname() {
      return hostname;
    },
    setHostname: (name) => {
      hostname = name;
    },
    setAddress: () => {},
    setShutdown: () => {},
  };

  return {
    get prompt() {
      return prompt(hostname, mode);
    },
    run(line) {
      const result = parse(line, mode, demoTree);
      if (result.kind === 'empty') return [];
      if (result.kind === 'error') return formatError(result.error, this.prompt.length);
      const output = result.execute(ctx);
      mode = result.mode;
      return output;
    },
    help(line) {
      return formatHelp(help(line, mode, demoTree), this.prompt.length);
    },
    complete: (line) => complete(line, mode, demoTree),
    end() {
      mode = endMode(mode);
      return [];
    },
  };
}
