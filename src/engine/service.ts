import type { SimAPI, SimEventBatch, SimMode } from './api';
import { after, ms, type SimTime } from './core/time';
import type { Engine } from './engine';
import type { EventId, SimEvent } from './events';
import { macTable, switchingModule } from './l2/switching';
import { arpTable } from './l3/arp';
import { routesOf } from './l3/context';
import { ipModule } from './l3/ip';
import { startPing } from './l3/ping';

/** The wall clock and frame timer that drive playback. The worker passes the real ones. */
export type FrameClock = {
  now(): number;
  request(callback: () => void): void;
};

const MAX_FRAME_MS = 100;
const MAX_STEPS_PER_FRAME = 8;
const MAX_SILENT_STEPS = 10_000;

type Playback =
  { playing: false } | { playing: true; speed: number; lastWall: number; stepCredit: number };

type Status = { now: SimTime; mode: SimMode; playing: boolean };

const sameStatus = (left: Status, right: Status) =>
  left.now === right.now && left.mode === right.mode && left.playing === right.playing;

/** Implements SimAPI on top of an engine. Batches go to the listener at most once per frame. */
export function createSimService({
  engine,
  frames,
}: {
  engine: Engine;
  frames: FrameClock;
}): SimAPI {
  let mode: SimMode = 'realtime';
  let playback: Playback = { playing: false };
  let listener: ((batch: SimEventBatch) => void) | undefined;
  let flushed = 0 as EventId;
  let sent: Status | undefined;
  let framePending = false;

  function stepToNextLog(): SimEvent[] {
    for (let silent = 0; silent < MAX_SILENT_STEPS && engine.nextTime() !== undefined; silent++) {
      const events = engine.step();
      if (events.length > 0) return events;
    }
    return [];
  }

  function advance(play: Extract<Playback, { playing: true }>) {
    const wall = frames.now();
    const elapsed = Math.min(Math.max(wall - play.lastWall, 0), MAX_FRAME_MS);
    play.lastWall = wall;
    if (mode === 'realtime') {
      engine.runUntil(after(engine.now, ms(elapsed * play.speed)));
      return;
    }
    play.stepCredit = Math.min(
      play.stepCredit + (elapsed * play.speed) / 1000,
      MAX_STEPS_PER_FRAME,
    );
    for (; play.stepCredit >= 1; play.stepCredit -= 1) stepToNextLog();
  }

  function flush() {
    if (!listener) return;
    const status: Status = { now: engine.now, mode, playing: playback.playing };
    const events = engine.log.since(flushed);
    if (events.length === 0 && sent && sameStatus(sent, status)) return;
    flushed = engine.log.lastId;
    sent = status;
    listener({ ...status, events });
  }

  function onFrame() {
    framePending = false;
    if (playback.playing) {
      advance(playback);
      requestFrame();
    }
    flush();
  }

  function requestFrame() {
    if (framePending) return;
    framePending = true;
    frames.request(onFrame);
  }

  return {
    load(topology) {
      engine.load(topology);
      flushed = 0 as EventId;
      requestFrame();
    },
    applyPatch(patch) {
      engine.applyPatch(patch);
      requestFrame();
    },
    setMode(next) {
      mode = next;
      playback = { playing: false };
      requestFrame();
    },
    step() {
      playback = { playing: false };
      const events = stepToNextLog();
      requestFrame();
      return events;
    },
    play(speed) {
      if (!Number.isFinite(speed) || speed <= 0) {
        throw new RangeError(`Speed must be a finite number > 0, got ${speed}`);
      }
      playback = { playing: true, speed, lastWall: frames.now(), stepCredit: 0 };
      requestFrame();
    },
    pause() {
      playback = { playing: false };
      requestFrame();
    },
    runCommand: () => ({ kind: 'not-implemented' }),
    ping(device, target, options, listener) {
      const { count, timeoutMs } = options;
      if (!Number.isInteger(count) || count < 1) {
        throw new RangeError(`Count must be a whole number >= 1, got ${count}`);
      }
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new RangeError(
          `Timeout must be a finite number of milliseconds > 0, got ${timeoutMs}`,
        );
      }
      const started = engine.withModule(device, ipModule, (ctx) =>
        startPing(ctx, target, options, listener),
      );
      requestFrame();
      return started;
    },
    arpTable: (device) => engine.withModule(device, ipModule, arpTable),
    routes: (device) => engine.withModule(device, ipModule, (ctx) => routesOf(ctx).routes),
    macTable: (device) =>
      engine.withModule(device, switchingModule, (ctx) => macTable(ctx.state, ctx.now)),
    subscribe(next) {
      listener = next;
      sent = undefined;
      requestFrame();
    },
  };
}
