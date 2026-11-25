import type {
  ArpTableEntry,
  DeviceUnavailable,
  MacTableEntry,
  PingListener,
  PingOptions,
  Route,
  SpanningTreeVlan,
} from '../../engine/api';
import type { Ipv4Address, PortId, Result } from '../../model';
import type { IosDevice } from './context';
import { pingOutput } from './ping';

/** Whether each port's link is up, as the simulation sees it. */
export type PortStates = Readonly<Partial<Record<PortId, boolean>>>;

/** The live state a show command can ask the simulation for, by kind, and what it gets back. */
export interface EngineAnswers {
  readonly routes: readonly Route[];
  readonly arp: readonly ArpTableEntry[];
  readonly macTable: readonly MacTableEntry[];
  readonly ports: PortStates;
  /** The simulated clock, in milliseconds since the run started. */
  readonly clock: number;
  readonly spanningTree: readonly SpanningTreeVlan[];
}

export type EngineQueryKind = keyof EngineAnswers;

/**
 * Prints a show command from live state. With no simulation to ask, `answer` is undefined and the
 * output comes from the config alone.
 */
export type Render<K extends EngineQueryKind, D extends IosDevice = IosDevice> = (
  answer: EngineAnswers[K] | undefined,
  device: D,
) => readonly string[];

/**
 * A show command waiting on live state. The session prints its config-only output at once; a
 * terminal that can reach the simulation asks it for `kind` and prints `render(answer)` instead.
 */
export type EngineQuery<K extends EngineQueryKind = EngineQueryKind> = {
  readonly [P in K]: {
    readonly kind: P;
    readonly render: (answer: EngineAnswers[P]) => readonly string[];
  };
}[K];

/** A show command's query, with its render bound to the device the command ran on. */
export function bindQuery<K extends EngineQueryKind>(
  kind: K,
  render: Render<K>,
  device: IosDevice,
): EngineQuery {
  // `K` is one kind, so this is the union member for it; TypeScript cannot see that through K.
  return { kind, render: (answer: EngineAnswers[K]) => render(answer, device) } as EngineQuery;
}

/** The query with `map` applied to its output, such as an output modifier's filter. */
export function mapQuery(
  query: EngineQuery,
  map: (lines: readonly string[]) => readonly string[],
): EngineQuery {
  // Each member's render takes its own answer; the union's call signature takes their intersection.
  const render = query.render as (answer: never) => readonly string[];
  return { kind: query.kind, render: (answer: never) => map(render(answer)) } as EngineQuery;
}

/** Asks the simulation for each kind of state on one device. Undefined when it cannot answer. */
export type EngineSource = {
  readonly [K in EngineQueryKind]: () => Promise<EngineAnswers[K] | undefined>;
};

/** The query's output from live state, or undefined when the source could not answer. */
export async function answerQuery<K extends EngineQueryKind>(
  query: EngineQuery<K>,
  source: EngineSource,
): Promise<readonly string[] | undefined> {
  const answer = await source[query.kind]();
  return answer === undefined ? undefined : query.render(answer);
}

/** `ping`: echo requests whose fates arrive as the simulation runs. */
export interface PingStream {
  readonly kind: 'ping';
  readonly target: Ipv4Address;
  readonly options: PingOptions;
}

/**
 * A command whose output arrives a piece at a time as the simulation runs, rather than in one
 * answer as a show command's does.
 */
export type EngineStream = PingStream;

/** Opens streams on the simulation for one device. */
export interface StreamSource {
  /** Starts a ping. Its events go to `listener` as simulated time passes. */
  ping(
    target: Ipv4Address,
    options: PingOptions,
    listener: PingListener,
  ): Promise<Result<void, DeviceUnavailable>>;
}

/** Output that arrives in pieces. Pieces are text that breaks lines with `\n`. */
export interface OutputStream {
  /** Writes each piece as it arrives. Resolves once the output is complete or aborted. */
  start(write: (text: string) => void): Promise<void>;
  /**
   * Ends the output early, as Ctrl+Shift+6 does. The simulation cannot cancel a ping yet, so it
   * runs on and its later events are dropped.
   */
  abort(): void;
}

const UNAVAILABLE: Readonly<Record<DeviceUnavailable, string>> = {
  'unknown-device': '% The simulation has not loaded this device yet.',
  'powered-off': '% The device is powered off.',
  unsupported: '% This device cannot send pings.',
};

const asText = (lines: readonly string[]) => lines.map((line) => `${line}\n`).join('');

/**
 * Runs the stream against the simulation `source` reaches. When it cannot be reached, the output
 * is `offline`, what the command prints with no simulation.
 */
export function openStream(
  stream: EngineStream,
  source: () => Promise<StreamSource>,
  offline: readonly string[],
): OutputStream {
  const output = pingOutput(stream);
  let abort = () => {};
  return {
    start(write) {
      return new Promise<void>((resolve) => {
        let open = true;
        let started = false;
        const end = (text: string) => {
          if (!open) return;
          open = false;
          write(text);
          resolve();
        };
        abort = () => end(started ? output.abort() : '');
        const run = async () => {
          const sim = await source();
          if (!open) return;
          started = true;
          write(output.head);
          const result = await sim.ping(stream.target, stream.options, (event) => {
            if (!open) return;
            const text = output.next(event);
            if (event.kind === 'summary') end(text);
            else write(text);
          });
          if (!result.ok) end(asText([UNAVAILABLE[result.error]]));
        };
        run().catch(() => end(asText(offline)));
      });
    },
    abort: () => abort(),
  };
}
