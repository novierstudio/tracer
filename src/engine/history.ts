import type { Engine, EngineSnapshot } from './engine';
import type { SimEvent } from './events';

const MAX_SILENT_STEPS = 10_000;

/**
 * Runs the next instant that logs something: queued events are processed until one logs, then
 * every other event at that same simulated time, so each packet in flight moves one hop. Returns
 * what was logged, or nothing when the queue had nothing that logs.
 */
export function stepInstant(engine: Engine): SimEvent[] {
  const mark = engine.log.lastId;
  for (let silent = 0; silent < MAX_SILENT_STEPS && engine.nextTime() !== undefined; silent++) {
    if (engine.step().length === 0) continue;
    engine.runUntil(engine.now);
    return engine.log.since(mark);
  }
  return [];
}

/** Something from outside the engine, such as a patch or a ping, applied at one moment. */
export type Input = {
  apply(): void;
  /** Called when the moment the input was applied at is cut from the history. */
  forget?(): void;
};

/** The state after one step, and the inputs applied on top of it before the next step. */
type Moment = { inputs: Input[]; snapshot?: EngineSnapshot };

export type HistoryOptions = {
  /** Events between snapshots. Stepping back replays at most about this many. */
  snapshotEvery?: number;
  /** Moments kept. Older ones are dropped, and stepping back stops at the oldest kept. */
  limit?: number;
};

export type History = {
  readonly canStepBack: boolean;
  /** Steps forward one instant: through the known future if there is one, else into a new one. */
  forward(): boolean;
  /** Returns to the moment before this one: the nearest snapshot, then a deterministic replay. */
  back(): boolean;
  /**
   * Applies an input at the current moment and records it, so a replay applies it again at the
   * same point. Any future that was stepped back from is cut, as an edit after undo cuts redo.
   */
  input(input: Input): void;
  /** Cuts the future that was stepped back from, as leaving Simulation mode does. */
  dropFuture(): void;
};

/**
 * Simulation mode's timeline. Moment 0 is where it began. Each step forward adds a moment, a
 * snapshot is kept every `snapshotEvery` events, and the engine is deterministic, so any moment
 * is its nearest snapshot plus the same steps and inputs replayed.
 */
export function createHistory(
  engine: Engine,
  { snapshotEvery = 32, limit = 10_000 }: HistoryOptions = {},
): History {
  const moments: Moment[] = [{ inputs: [], snapshot: engine.snapshot() }];
  let at = 0;
  let eventsSinceSnapshot = 0;

  function applyInputs() {
    for (const input of moments[at]!.inputs) input.apply();
  }

  function advance(): boolean {
    const events = stepInstant(engine);
    if (events.length === 0) return false;
    at += 1;
    const moment = (moments[at] ??= { inputs: [] });
    eventsSinceSnapshot += events.length;
    if (!moment.snapshot && eventsSinceSnapshot >= snapshotEvery)
      moment.snapshot = engine.snapshot();
    if (moment.snapshot) eventsSinceSnapshot = 0;
    applyInputs();
    return true;
  }

  function dropFuture() {
    for (const cut of moments.splice(at + 1)) for (const old of cut.inputs) old.forget?.();
  }

  function dropOldest() {
    if (moments.length <= limit) return;
    const next = moments.findIndex((moment, index) => index > 0 && moment.snapshot);
    if (next <= 0 || next > at) return;
    moments.splice(0, next);
    at -= next;
  }

  return {
    get canStepBack() {
      return at > 0;
    },
    forward() {
      const stepped = advance();
      if (stepped) dropOldest();
      return stepped;
    },
    back() {
      if (at === 0) return false;
      const target = at - 1;
      let from = target;
      while (!moments[from]!.snapshot) from -= 1;
      engine.restore(moments[from]!.snapshot!);
      at = from;
      eventsSinceSnapshot = 0;
      applyInputs();
      while (at < target && advance());
      return true;
    },
    input(input) {
      dropFuture();
      moments[at]!.inputs.push(input);
      input.apply();
    },
    dropFuture,
  };
}
