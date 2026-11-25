import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import type { SimEventBatch, SimMode } from '@/engine/api';
import type { SimTime } from '@/engine/core/time';
import type { EventId, FrameEvent } from '@/engine/events';
import { readJson, safeStorage } from '@/app/storage';
import type { DeviceId } from '@/model';
import type { ProtocolId } from './protocols';

export const PLAY_SPEEDS = [0.25, 0.5, 1, 2, 4] as const;
export type PlaySpeed = (typeof PLAY_SPEEDS)[number];

/** The Add simple PDU tool: off, waiting for the source device, or for the destination. */
export type PduTool =
  | { step: 'off' }
  | { step: 'source'; problem?: string }
  | { step: 'destination'; source: DeviceId; problem?: string };

export type PduStatus = 'in flight' | 'successful' | 'failed';

/** An echo the tool queued, and what became of it. */
export type Pdu = { id: number; source: DeviceId; destination: DeviceId; status: PduStatus };

const MAX_FRAMES = 20_000;

export type SimulationState = {
  /** The mode the user picked. The engine follows it; batches never overwrite it. */
  mode: SimMode;
  playing: boolean;
  speed: PlaySpeed;
  /** The engine's clock and newest event id, as of the latest batch. */
  now: SimTime;
  head: EventId;
  canStepBack: boolean;
  /** Frames logged since Simulation mode began, oldest first. None has an id above `head`. */
  frames: readonly FrameEvent[];
  hidden: readonly ProtocolId[];
  selected: EventId | undefined;
  /** Bumped to ask the canvas to pan to the selected event's packet. */
  focusRequest: number;
  showTraffic: boolean;
  pdu: PduTool;
  pdus: readonly Pdu[];
};

const SHOW_TRAFFIC_KEY = 'tracer.showTraffic';

export const simulationStore = createStore<SimulationState>(() => ({
  mode: 'realtime',
  playing: false,
  speed: 1,
  now: 0 as SimTime,
  head: 0 as EventId,
  canStepBack: false,
  frames: [],
  hidden: [],
  selected: undefined,
  focusRequest: 0,
  showTraffic:
    readJson(SHOW_TRAFFIC_KEY, (value) => (typeof value === 'boolean' ? value : undefined)) ?? true,
  pdu: { step: 'off' },
  pdus: [],
}));

simulationStore.subscribe((state, previous) => {
  if (state.showTraffic !== previous.showTraffic) {
    safeStorage.setItem(SHOW_TRAFFIC_KEY, JSON.stringify(state.showTraffic));
  }
});

export function useSimulation<T>(selector: (state: SimulationState) => T): T {
  return useStore(simulationStore, selector);
}

const isFrame = (event: SimEventBatch['events'][number]): event is FrameEvent =>
  event.kind === 'frame';

/**
 * Folds a batch into the state. Only Simulation batches add to the event list. Ids are positions
 * in the run, so a batch's events replace any held from its first id on, and a lower head drops
 * the events a step back undid.
 */
export function receiveBatch(
  state: SimulationState,
  batch: SimEventBatch,
): Partial<SimulationState> {
  const status = {
    playing: batch.playing,
    now: batch.now,
    head: batch.head,
    canStepBack: batch.canStepBack,
  };
  if (batch.mode !== 'simulation') return status;

  const firstNew = batch.events[0]?.id ?? Infinity;
  const { frames } = state;
  let keep = frames.length;
  while (keep > 0 && (frames[keep - 1]!.id > batch.head || frames[keep - 1]!.id >= firstNew)) {
    keep -= 1;
  }
  const added = batch.events.filter(isFrame);
  if (keep === frames.length && added.length === 0) return status;

  const next = [...frames.slice(Math.max(0, keep + added.length - MAX_FRAMES), keep), ...added];
  const selected =
    state.selected !== undefined && state.selected <= batch.head ? state.selected : undefined;
  return { ...status, frames: next, selected };
}

/** The frames that arrived at the current instant: where each packet is now. */
export function currentFrames({ frames, now }: Pick<SimulationState, 'frames' | 'now'>) {
  const current: FrameEvent[] = [];
  for (let index = frames.length - 1; index >= 0 && frames[index]!.time >= now; index--) {
    if (frames[index]!.time === now) current.unshift(frames[index]!);
  }
  return current;
}

/** Frames are sorted by id, so the selected one is a binary search away. */
export function findFrame(frames: readonly FrameEvent[], id: EventId): FrameEvent | undefined {
  let low = 0;
  let high = frames.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const frame = frames[middle]!;
    if (frame.id === id) return frame;
    if (frame.id < id) low = middle + 1;
    else high = middle - 1;
  }
  return undefined;
}

/** The selected frame, while it is still in the list. */
export const selectedFrame = ({
  frames,
  selected,
}: Pick<SimulationState, 'frames' | 'selected'>) =>
  selected === undefined ? undefined : findFrame(frames, selected);
