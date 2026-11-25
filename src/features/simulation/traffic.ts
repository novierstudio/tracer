import type { FrameEvent } from '@/engine/events';
import type { DeviceId } from '@/model';
import { protocolOf, type ProtocolId } from './protocols';

/**
 * How a chip moves along its link. `travel` crosses once and goes (realtime). `arrive` crosses
 * and stays at the far end, where its packet now is (a step forward). `return` slides back to
 * the sending end and goes (a step back). `rest` sits at the far end.
 */
export type Motion = 'travel' | 'arrive' | 'return' | 'rest';

export type Chip = {
  readonly id: number;
  readonly event: FrameEvent;
  readonly protocol: ProtocolId;
  /** Wall-clock ms, as performance.now() counts them. */
  readonly start: number;
  readonly duration: number;
  readonly motion: Motion;
};

/** A chip on screen: `along` runs from 0 at the sending end to 1 at the receiving end. */
export type ChipPlace = { readonly chip: Chip; readonly along: number; readonly moving: boolean };

/**
 * Realtime links take 1 simulated ms, far too fast to see, so each hop is stretched to 300 ms on
 * screen: long enough to follow a chip across a 200 to 400 px link, short enough that a ping's
 * 8 hops across a router play in about 2.4 s. Delays scale linearly, within 180 to 1200 ms.
 */
export const VISIBLE_MS_PER_SIM_MS = 300;
export const MIN_TRAVEL_MS = 180;
export const MAX_TRAVEL_MS = 1200;

/** Chips on screen at once. Past it, the oldest go first. */
export const CHIP_CAP = 200;
/** Chips waiting for their turn. A storm past this drops the oldest waiting ones. */
const MAX_HELD = CHIP_CAP * 8;
/** How far back in simulated time a frame can still find the arrival it continues. */
const ARRIVAL_MEMORY_SIM_MS = 50;

export function travelMs({ time, sentAt }: Pick<FrameEvent, 'time' | 'sentAt'>): number {
  const stretched = (time - sentAt) * VISIBLE_MS_PER_SIM_MS;
  return Math.min(MAX_TRAVEL_MS, Math.max(MIN_TRAVEL_MS, stretched));
}

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

const ends = (chip: Chip) => chip.motion === 'travel' || chip.motion === 'return';

function place(chip: Chip, wallNow: number, reducedMotion: boolean): ChipPlace {
  if (chip.motion === 'rest') return { chip, along: 1, moving: false };
  const progress = reducedMotion
    ? 1
    : Math.min(1, Math.max(0, (wallNow - chip.start) / chip.duration));
  const along = chip.motion === 'return' ? 1 - ease(progress) : ease(progress);
  return { chip, along, moving: progress < 1 };
}

const arrivalKey = (device: DeviceId, time: number) => `${device} ${time}`;

export type Moment = {
  /** Frames that just arrived: they slide across, then stay. */
  arriving: readonly FrameEvent[];
  /** Frames already where they are. */
  resting: readonly FrameEvent[];
  /** Frames a step back undid: they slide back to where they came from. */
  leaving: readonly FrameEvent[];
};

export type Traffic = ReturnType<typeof createTraffic>;

/**
 * The chips the overlay draws. In realtime, a frame sent the instant another arrived at its
 * device continues that packet's journey, so its chip waits for the earlier chip to land: a
 * packet crosses the network hop by hop, and a broadcast fans out from where it arrived. In
 * Simulation mode, chips show the current moment instead.
 */
export function createTraffic({ cap = CHIP_CAP }: { cap?: number } = {}) {
  let chips: Chip[] = [];
  let nextId = 1;
  // When the chip of the last frame to reach each device at each simulated instant lands.
  const landings = new Map<string, { time: number; end: number }>();
  let latest = 0;

  const chip = (event: FrameEvent, start: number, duration: number, motion: Motion): Chip => ({
    id: nextId++,
    event,
    protocol: protocolOf(event.frame),
    start,
    duration,
    motion,
  });

  function forgetOldLandings() {
    for (const [key, { time }] of landings) {
      if (time < latest - ARRIVAL_MEMORY_SIM_MS) landings.delete(key);
    }
  }

  return {
    addRealtime(events: readonly FrameEvent[], wallNow: number) {
      for (const event of events) {
        const after = landings.get(arrivalKey(event.from.device, event.sentAt))?.end ?? 0;
        const start = Math.max(wallNow, after);
        const duration = travelMs(event);
        chips.push(chip(event, start, duration, 'travel'));
        const key = arrivalKey(event.to.device, event.time);
        const end = Math.max(landings.get(key)?.end ?? 0, start + duration);
        landings.set(key, { time: event.time, end });
        latest = Math.max(latest, event.time);
      }
      forgetOldLandings();
      if (chips.length > MAX_HELD) chips = chips.slice(chips.length - MAX_HELD);
    },

    showMoment({ arriving, resting, leaving }: Moment, wallNow: number, slideMs: number) {
      landings.clear();
      chips = [
        ...leaving.map((event) => chip(event, wallNow, slideMs, 'return')),
        ...arriving.map((event) => chip(event, wallNow, slideMs, 'arrive')),
        ...resting.map((event) => chip(event, wallNow, slideMs, 'rest')),
      ];
    },

    clear() {
      chips = [];
      landings.clear();
    },

    /**
     * The chips on screen at `wallNow`. Finished ones are dropped for good, and so are the
     * oldest on screen past the cap.
     */
    frame(wallNow: number, { reducedMotion = false } = {}): ChipPlace[] {
      chips = chips.filter((c) => !(ends(c) && c.start + c.duration <= wallNow));
      let shown = chips.filter((c) => c.start <= wallNow);
      if (shown.length > cap) {
        const dropped = new Set(
          [...shown].sort((a, b) => a.start - b.start).slice(0, shown.length - cap),
        );
        chips = chips.filter((c) => !dropped.has(c));
        shown = shown.filter((c) => !dropped.has(c));
      }
      return shown.map((c) => place(c, wallNow, reducedMotion));
    },

    /** Whether any chip is on screen or waiting for its turn. */
    get busy() {
      return chips.length > 0;
    },
  };
}
