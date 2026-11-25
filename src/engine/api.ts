import type { DeviceId, Topology } from '@/model';
import type { SimTime } from './core/time';
import type { SimEvent } from './events';
import type { TopologyPatch } from './patch';

export type SimMode = 'realtime' | 'simulation';

/** What the worker sends once per animation frame when something changed. */
export type SimEventBatch = { now: SimTime; mode: SimMode; playing: boolean; events: SimEvent[] };

export type CliResult = { kind: 'not-implemented' };

/** The simulation worker's contract with the main thread. */
export interface SimAPI {
  /** Starts a new run from this topology: the clock, the queue, the log and the seed all reset. */
  load(topology: Topology): void;
  applyPatch(patch: TopologyPatch): void;
  /** Switches mode. Either mode starts paused. */
  setMode(mode: SimMode): void;
  /** Pauses, then runs until the next event that logs something. Returns what it logged. */
  step(): SimEvent[];
  /**
   * Realtime: `speed` simulated ms per wall-clock ms, so 1 tracks the wall clock.
   * Simulation: `speed` logged steps per second.
   */
  play(speed: number): void;
  pause(): void;
  runCommand(device: DeviceId, line: string): CliResult;
  /** Sets the one batch listener. Calling it again replaces the previous listener. */
  subscribe(listener: (batch: SimEventBatch) => void): void;
}
