import type { FrameEvent } from '@/engine/events';
import { BROADCAST_MAC } from '@/engine/pdu';
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
  /** Why the frame was dropped, such as "No route". Undefined when it was not dropped. */
  readonly drop: string | undefined;
  /** Whether it carries on from a chip that lands as it starts, so it needs no entrance. */
  readonly chained: boolean;
};

/** A chip on screen: `along` runs from 0 at the sending end to 1 at the receiving end. */
export type ChipPlace = {
  readonly chip: Chip;
  readonly along: number;
  /** Sliding, which earns it a trail. */
  readonly moving: boolean;
  /** At its drop point: a red cross stands in for the chip. */
  readonly dropped: boolean;
  /** Size and opacity. Realtime chips grow in and shrink out, and a cross pops past 1. */
  readonly scale: number;
  readonly alpha: number;
};

/** A ring that spreads from a device as copies of one frame leave it. `spread` runs 0 to 1. */
export type RingPlace = {
  readonly device: DeviceId;
  readonly protocol: ProtocolId;
  readonly spread: number;
  readonly alpha: number;
};

export type TrafficFrame = { chips: ChipPlace[]; rings: RingPlace[] };

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

/** A realtime chip grows and fades in over this long, and out again unless its packet goes on. */
const FADE_MS = 110;
/** How long a realtime drop's cross stays, long enough to hover it, and its fade at the end. */
export const DROP_LINGER_MS = 1600;
const DROP_FADE_MS = 300;
const POP_MS = 280;
export const RING_MS = 700;
const MAX_RINGS = 64;
/** Under reduced motion a ring holds still at this spread instead of spreading. */
const STILL_SPREAD = 0.3;

export function travelMs({ time, sentAt }: Pick<FrameEvent, 'time' | 'sentAt'>): number {
  const stretched = (time - sentAt) * VISIBLE_MS_PER_SIM_MS;
  return Math.min(MAX_TRAVEL_MS, Math.max(MIN_TRAVEL_MS, stretched));
}

const clamp01 = (t: number) => Math.min(1, Math.max(0, t));

/**
 * Constant speed blended with a sine ease. `firm` 1 starts and stops at rest, as a step's slide
 * should. Realtime hops use 0.5: a chip slows to half its mean speed at each end, so a packet
 * flows through a device instead of stopping dead at it.
 */
const glide = (t: number, firm: number) =>
  (1 - firm) * t + (firm * (1 - Math.cos(Math.PI * t))) / 2;

/** Grows from 0 past 1 and settles back, for a cross that pops in. */
function pop(t: number) {
  const c = 1.70158;
  return 1 + (c + 1) * (t - 1) ** 3 + c * (t - 1) ** 2;
}

const arrivalKey = (device: DeviceId, time: number) => `${device} ${time}`;

/**
 * A flood or a broadcast: copies of one frame that left a device at once, keyed by device,
 * instant and destination. Spanning tree's hellos leave every port at once too, but each is its
 * own frame, so they do not count.
 */
function fanOutKey(event: FrameEvent): string | undefined {
  const { frame } = event;
  if (frame.kind !== 'ethernet' || frame.payload.kind === 'bpdu') return undefined;
  return `${event.from.device} ${event.sentAt} ${frame.dst}`;
}

type Ring = { key: string; device: DeviceId; protocol: ProtocolId; start: number };

/** The rings for chips that set off together: a broadcast, or two or more copies of a frame. */
function ringsFor(chips: readonly Chip[]): Ring[] {
  const groups = new Map<string, Chip[]>();
  for (const chip of chips) {
    const key = fanOutKey(chip.event);
    if (key) groups.set(key, [...(groups.get(key) ?? []), chip]);
  }
  const rings: Ring[] = [];
  for (const [key, group] of groups) {
    const { event, protocol, start } = group[0]!;
    const broadcast = event.frame.kind === 'ethernet' && event.frame.dst === BROADCAST_MAC;
    if (broadcast || group.length > 1) {
      rings.push({ key, device: event.from.device, protocol, start });
    }
  }
  return rings;
}

export type Moment = {
  /** Frames that just arrived: they slide across, then stay. */
  arriving: readonly FrameEvent[];
  /** Frames already where they are. */
  resting: readonly FrameEvent[];
  /** Frames a step back undid: they slide back to where they came from. */
  leaving: readonly FrameEvent[];
};

export type Traffic = ReturnType<typeof createTraffic>;

/** Why a frame was dropped, such as "No route", or undefined when it was not. */
export type DropLabeller = (event: FrameEvent) => string | undefined;

/** All a frame says by itself: whether its link was down. The overlay brings the rest. */
const linkDrops: DropLabeller = (event) =>
  event.outcome === 'link-down' ? 'Link down' : undefined;

/**
 * The chips the overlay draws. In realtime, a frame sent the instant another arrived at its
 * device continues that packet's journey, so its chip waits for the earlier chip to land: a
 * packet crosses the network hop by hop, and a broadcast fans out from where it arrived. In
 * Simulation mode, chips show the current moment instead. `drop` names why a frame was
 * dropped. It is passed in, so the main bundle need not carry the decision logic.
 */
export function createTraffic({
  cap = CHIP_CAP,
  drop = linkDrops,
}: { cap?: number; drop?: DropLabeller } = {}) {
  let labelDrop = drop;
  let chips: Chip[] = [];
  let rings: Ring[] = [];
  let nextId = 1;
  // When the chips that reach each device at each simulated instant land, and which they are.
  const landings = new Map<string, { time: number; end: number; arrivals: Chip[] }>();
  // Chips whose packet goes on from where they land, so they do not fade out there.
  const continued = new WeakSet<Chip>();
  let latest = 0;
  const listeners = new Set<() => void>();
  const changed = () => listeners.forEach((listener) => listener());

  const chip = (
    event: FrameEvent,
    start: number,
    duration: number,
    motion: Motion,
    chained = false,
  ): Chip => ({
    id: nextId++,
    event,
    protocol: protocolOf(event.frame),
    start,
    duration,
    motion,
    drop: labelDrop(event),
    chained,
  });

  function forgetOldLandings() {
    for (const [key, { time }] of landings) {
      if (time < latest - ARRIVAL_MEMORY_SIM_MS) landings.delete(key);
    }
  }

  function addRings(fresh: readonly Chip[], wallNow: number) {
    rings = rings.filter((ring) => ring.start + RING_MS > wallNow);
    const live = new Set(rings.map((ring) => ring.key));
    rings.push(...ringsFor(fresh).filter((ring) => !live.has(ring.key)));
    if (rings.length > MAX_RINGS) rings = rings.slice(rings.length - MAX_RINGS);
  }

  /** When a chip leaves the screen: never, for one that stays where it landed. */
  function endOf(c: Chip) {
    if (c.motion === 'return') return c.start + c.duration;
    if (c.motion !== 'travel') return Infinity;
    if (c.drop === undefined) return c.start + c.duration;
    return landsAt(c) + DROP_LINGER_MS;
  }

  function place(c: Chip, wallNow: number, reducedMotion: boolean): ChipPlace {
    const lost = c.event.outcome === 'link-down';
    const elapsed = wallNow - c.start;
    const progress = reducedMotion || c.motion === 'rest' ? 1 : clamp01(elapsed / c.duration);
    const eased = glide(progress, c.motion === 'travel' ? 0.5 : 1);
    const along = lost ? 0 : c.motion === 'return' ? 1 - eased : eased;
    const dropped = c.drop !== undefined && (lost || (c.motion !== 'return' && progress >= 1));
    const moving = !dropped && progress < 1;
    if (reducedMotion) return { chip: c, along, moving, dropped, scale: 1, alpha: 1 };

    if (dropped) {
      const age = wallNow - landsAt(c);
      const settled = c.motion === 'rest' || c.motion === 'return';
      const scale = settled ? 1 : pop(clamp01(age / POP_MS));
      const alpha = c.motion === 'travel' ? clamp01((DROP_LINGER_MS - age) / DROP_FADE_MS) : 1;
      return { chip: c, along, moving, dropped, scale, alpha };
    }
    if (c.motion !== 'travel') return { chip: c, along, moving, dropped, scale: 1, alpha: 1 };
    const fadeIn = c.chained ? 1 : elapsed / FADE_MS;
    const fadeOut = c.drop !== undefined || continued.has(c) ? 1 : (c.duration - elapsed) / FADE_MS;
    const presence = clamp01(Math.min(fadeIn, fadeOut));
    return { chip: c, along, moving, dropped, scale: 0.6 + 0.4 * presence, alpha: presence };
  }

  return {
    addRealtime(events: readonly FrameEvent[], wallNow: number) {
      const fresh: Chip[] = [];
      for (const event of events) {
        const landing = landings.get(arrivalKey(event.from.device, event.sentAt));
        // A packet that landed and left the screen before its next hop came starts afresh.
        const chained = landing !== undefined && landing.end >= wallNow;
        if (chained) for (const arrival of landing.arrivals) continued.add(arrival);
        const start = chained ? landing.end : wallNow;
        const duration = travelMs(event);
        const next = chip(event, start, duration, 'travel', chained);
        chips.push(next);
        fresh.push(next);
        const key = arrivalKey(event.to.device, event.time);
        const arriving = landings.get(key);
        if (arriving) {
          arriving.end = Math.max(arriving.end, start + duration);
          arriving.arrivals.push(next);
        } else {
          landings.set(key, { time: event.time, end: start + duration, arrivals: [next] });
        }
        latest = Math.max(latest, event.time);
      }
      addRings(fresh, wallNow);
      forgetOldLandings();
      if (chips.length > MAX_HELD) chips = chips.slice(chips.length - MAX_HELD);
      changed();
    },

    showMoment({ arriving, resting, leaving }: Moment, wallNow: number, slideMs: number) {
      landings.clear();
      const arrived = arriving.map((event) => chip(event, wallNow, slideMs, 'arrive'));
      chips = [
        ...leaving.map((event) => chip(event, wallNow, slideMs, 'return')),
        ...arrived,
        ...resting.map((event) => chip(event, wallNow, slideMs, 'rest')),
      ];
      addRings(arrived, wallNow);
      changed();
    },

    /** Names drops from now on with `next`, as the overlay does once it has loaded. */
    labelDrops(next: DropLabeller) {
      labelDrop = next;
    },

    clear() {
      chips = [];
      rings = [];
      landings.clear();
      changed();
    },

    /**
     * The chips and rings on screen at `wallNow`. Finished ones are dropped for good, and so are
     * the oldest chips on screen past the cap. Under reduced motion, chips jump to where they
     * are going and nothing spreads, pops or fades.
     */
    frame(wallNow: number, { reducedMotion = false } = {}): TrafficFrame {
      chips = chips.filter((c) => endOf(c) > wallNow);
      let shown = chips.filter((c) => c.start <= wallNow);
      if (shown.length > cap) {
        const dropped = new Set(
          [...shown].sort((a, b) => a.start - b.start).slice(0, shown.length - cap),
        );
        chips = chips.filter((c) => !dropped.has(c));
        shown = shown.filter((c) => !dropped.has(c));
      }
      rings = rings.filter((ring) => ring.start + RING_MS > wallNow);
      return {
        chips: shown.map((c) => place(c, wallNow, reducedMotion)),
        rings: rings
          .filter((ring) => ring.start <= wallNow)
          .map(({ device, protocol, start }) => {
            const t = (wallNow - start) / RING_MS;
            return reducedMotion
              ? { device, protocol, spread: STILL_SPREAD, alpha: 0.6 }
              : { device, protocol, spread: 1 - (1 - t) ** 3, alpha: 0.75 * (1 - t) };
          }),
      };
    },

    /**
     * Whether what `frame` shows will change after `wallNow`, so the overlay must draw again: a
     * chip slides, fades, pops, waits for its turn or will leave, or a ring spreads or will go.
     * Chips at rest where they landed, as a paused step leaves them, change no more.
     */
    animating(wallNow: number, { reducedMotion = false } = {}): boolean {
      return rings.length > 0 || chips.some((c) => changesAfter(c, wallNow, reducedMotion));
    },

    /** Calls `listener` whenever chips are added or cleared. Returns the unsubscribe. */
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };

  function changesAfter(c: Chip, wallNow: number, reducedMotion: boolean) {
    if (c.start > wallNow || endOf(c) !== Infinity) return true;
    if (reducedMotion || c.motion === 'rest') return false;
    // An arrival slides until it lands, and a dropped one's cross pops after that.
    return wallNow < landsAt(c) + (c.drop === undefined ? 0 : POP_MS);
  }
}

/** When a chip reaches the point it is drawn at for good: its far end, or at once if lost. */
function landsAt(chip: Chip) {
  return chip.event.outcome === 'link-down' ? chip.start : chip.start + chip.duration;
}
