import type { ArpTableEntry, MacTableEntry, Route } from '../../engine/api';
import type { PortId } from '../../model';
import type { IosDevice } from './context';

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
