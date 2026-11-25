import { isConfigMode, type CompleteResult, type DeviceSession, type IosDevice } from '@/cli';
import { describeTopologyError, type DeviceId } from '@/model';
import type { EditorStore } from '@/model/store';

/** One CLI connection: lines in, output lines and a prompt out. It owns the mode. */
export interface TerminalSession {
  readonly prompt: string;
  /** The line being typed is a password: the terminal must not echo it or keep it. */
  readonly masked: boolean;
  run(line: string): readonly string[];
  /** `?` help for the text before the cursor. */
  help(line: string): readonly string[];
  complete(line: string): CompleteResult;
  /** Ctrl+Z: leave config mode for privileged EXEC. */
  end(): readonly string[];
}

const NO_COMPLETION: CompleteResult = { line: undefined, candidates: [] };

/**
 * The console of a router or switch in an editor store. Each line reads the device as the store
 * has it now, so GUI edits between lines show, and commits the line's config edit as one undo step.
 */
export function deviceTerminal(
  store: EditorStore,
  id: DeviceId,
  session: DeviceSession,
): TerminalSession {
  // The device can vanish between a store change and the view unmounting.
  const device = (): IosDevice | undefined => {
    const current = store.getState().topology.devices[id];
    return current?.kind === 'router' || current?.kind === 'switch' ? current : undefined;
  };
  const run = (line: string): readonly string[] => {
    const current = device();
    if (!current) return [];
    const { output, update } = session.run(current, line);
    if (!update) return output;
    const committed = store.getState().updateConfig(update);
    return committed.ok ? output : [...output, `% ${describeTopologyError(committed.error)}`];
  };
  return {
    get prompt() {
      const current = device();
      return current ? session.prompt(current) : '';
    },
    get masked() {
      return session.readingPassword;
    },
    run,
    help(line) {
      const current = device();
      return current ? session.help(current, line) : [];
    },
    complete(line) {
      const current = device();
      return current ? session.complete(current, line) : NO_COMPLETION;
    },
    end: () => (isConfigMode(session.state.mode) && !session.state.pending ? run('end') : []),
  };
}
