import {
  answerQuery,
  isConfigMode,
  openStream,
  type CompleteResult,
  type DeviceSession,
  type EngineQuery,
  type EngineSource,
  type IosDevice,
  type OutputStream,
  type StreamSource,
} from '@/cli';
import type { SimAPI } from '@/engine/api';
import { describeTopologyError, type DeviceId, type Result } from '@/model';
import type { EditorStore } from '@/model/store';

/**
 * A line's output: lines, a promise of them when a show command waits on the simulation, or a
 * stream when the output arrives a piece at a time, as ping's does.
 */
export type Reply = readonly string[] | Promise<readonly string[]> | OutputStream;

export const isStream = (reply: Reply): reply is OutputStream => 'start' in reply;

/** One CLI connection: lines in, output lines and a prompt out. It owns the mode. */
export interface TerminalSession {
  readonly prompt: string;
  /** The line being typed is a password: the terminal must not echo it or keep it. */
  readonly masked: boolean;
  run(line: string): Reply;
  /** `?` help for the text before the cursor. */
  help(line: string): readonly string[];
  complete(line: string): CompleteResult;
  /** Ctrl+Z: leave config mode for privileged EXEC. */
  end(): Reply;
}

type Remote<F> = F extends (...args: infer A) => infer R ? (...args: A) => Promise<R> : never;

/** The simulation's queries that show commands read, as the worker's client offers them. */
export type SimQueries = {
  readonly [
    K in
      | 'routes'
      | 'arpTable'
      | 'macTable'
      | 'portStates'
      | 'spanningTree'
      | 'dhcpBindings'
      | 'routingProtocols'
      | 'aclHits'
      | 'natTranslations'
      | 'clearNatTranslations'
  ]: Remote<SimAPI[K]>;
};

/** What a console reads from the simulation. */
export type SimLink = SimQueries & {
  /** The simulated clock as of the latest batch, in milliseconds since the run started. */
  readonly now: () => number;
  readonly ping: (...args: Parameters<SimAPI['ping']>) => Promise<ReturnType<SimAPI['ping']>>;
  readonly traceroute: (
    ...args: Parameters<SimAPI['traceroute']>
  ) => Promise<ReturnType<SimAPI['traceroute']>>;
  readonly cancel: Remote<SimAPI['cancel']>;
};

/** Where to reach the simulation. It rejects when there is none, as in a test without a worker. */
export type EngineLink = () => Promise<SimLink>;

const valueOf = <T>(result: Result<T, unknown>): T | undefined =>
  result.ok ? result.value : undefined;

/** The simulation's answers for one device. A device it cannot run gives no answer. */
export function engineSource(sim: SimLink, device: DeviceId): EngineSource {
  return {
    routes: () => sim.routes(device).then(valueOf),
    arp: () => sim.arpTable(device).then(valueOf),
    macTable: () => sim.macTable(device).then(valueOf),
    ports: () => sim.portStates(device).then(valueOf),
    clock: async () => sim.now(),
    spanningTree: () => sim.spanningTree(device).then(valueOf),
    dhcpBindings: () => sim.dhcpBindings(device).then(valueOf),
    protocols: () => sim.routingProtocols(device).then(valueOf),
    aclHits: () => sim.aclHits(device).then(valueOf),
    natTranslations: () => sim.natTranslations(device).then(valueOf),
    natCleared: () => sim.clearNatTranslations(device).then(valueOf),
  };
}

/** Streams opened on the simulation for one device. */
function streamSource(sim: SimLink, device: DeviceId): StreamSource {
  return {
    ping: (target, options, listener) => sim.ping(device, target, options, listener),
    traceroute: (target, options, listener) => sim.traceroute(device, target, options, listener),
    cancel: (handle) => sim.cancel(handle),
  };
}

/** The query's output from live state, or `fallback` when the simulation cannot answer. */
async function answerLive(
  engine: EngineLink,
  device: DeviceId,
  query: EngineQuery,
  fallback: readonly string[],
): Promise<readonly string[]> {
  try {
    return (await answerQuery(query, engineSource(await engine(), device))) ?? fallback;
  } catch {
    return fallback;
  }
}

const NO_COMPLETION: CompleteResult = { line: undefined, candidates: [] };

/**
 * The console of a router or switch in an editor store. Each line reads the device as the store
 * has it now, so GUI edits between lines show, and commits the line's config edit as one undo step.
 * A show command that reads live state asks the simulation through `engine`, and a ping streams
 * from it; without one, or when the simulation cannot answer, it prints what the config alone says.
 */
export function deviceTerminal(
  store: EditorStore,
  id: DeviceId,
  session: DeviceSession,
  engine?: EngineLink,
): TerminalSession {
  // The device can vanish between a store change and the view unmounting.
  const device = (): IosDevice | undefined => {
    const current = store.getState().topology.devices[id];
    return current?.kind === 'router' || current?.kind === 'switch' ? current : undefined;
  };
  const run = (line: string): Reply => {
    const current = device();
    if (!current) return [];
    const { output, update, query, stream } = session.run(current, line);
    const committed = update && store.getState().updateConfig(update);
    const printed =
      committed && !committed.ok
        ? [...output, `% ${describeTopologyError(committed.error)}`]
        : output;
    if (!engine) return printed;
    if (query) return answerLive(engine, id, query, printed);
    if (stream)
      return openStream(stream, () => engine().then((sim) => streamSource(sim, id)), printed);
    return printed;
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
