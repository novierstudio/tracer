import type { Ipv4Address } from '@/model';
import type { PingEvent, PingListener, SimAPI, SimEventBatch } from './api';
import { after, ms } from './core/time';
import type { Engine } from './engine';
import type { EventId } from './events';
import { createHistory, stepInstant, type History, type Input } from './history';
import { macTable, spanningTreeOf, switchingModule } from './l2/switching';
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

type Playback =
  { playing: false } | { playing: true; speed: number; lastWall: number; stepCredit: number };

/** Realtime runs on the wall clock. Simulation steps through a history it can step back in. */
type Run = { mode: 'realtime' } | { mode: 'simulation'; history: History };

type Status = Pick<SimEventBatch, 'now' | 'mode' | 'playing' | 'head' | 'canStepBack'>;

const sameStatus = (left: Status, right: Status) =>
  left.now === right.now &&
  left.mode === right.mode &&
  left.playing === right.playing &&
  left.head === right.head &&
  left.canStepBack === right.canStepBack;

/**
 * Wraps a ping's listener so it hears each request's fate once, however often stepping back
 * replays it. If the history forgets the ping, it ends with a summary of what it heard.
 */
function hearOnce(target: Ipv4Address, listener: PingListener) {
  let heard = 0;
  const replies: number[] = [];
  return {
    listener(event: PingEvent) {
      const order = event.kind === 'summary' ? Infinity : event.seq;
      if (order <= heard) return;
      heard = order;
      if (event.kind === 'reply') replies.push(event.timeMs);
      listener(event);
    },
    forget() {
      if (heard === Infinity) return;
      const sent = heard;
      heard = Infinity;
      const total = replies.reduce((sum, time) => sum + time, 0);
      listener({
        kind: 'summary',
        target,
        sent,
        received: replies.length,
        ...(replies.length > 0 && {
          rtt: {
            minMs: Math.min(...replies),
            avgMs: total / replies.length,
            maxMs: Math.max(...replies),
          },
        }),
      });
    },
  };
}

/** Implements SimAPI on top of an engine. Batches go to the listener at most once per frame. */
export function createSimService({
  engine,
  frames,
}: {
  engine: Engine;
  frames: FrameClock;
}): SimAPI {
  let run: Run = { mode: 'realtime' };
  let playback: Playback = { playing: false };
  let listener: ((batch: SimEventBatch) => void) | undefined;
  let flushed = 0 as EventId;
  let sent: Status | undefined;
  let framePending = false;

  /** Applies an input now. In Simulation mode the history records it, so replays repeat it. */
  function input(entry: Input) {
    if (run.mode === 'simulation') run.history.input(entry);
    else entry.apply();
  }

  function stepOnce() {
    if (run.mode === 'simulation') run.history.forward();
    else stepInstant(engine);
  }

  function advance(play: Extract<Playback, { playing: true }>) {
    const wall = frames.now();
    const elapsed = Math.min(Math.max(wall - play.lastWall, 0), MAX_FRAME_MS);
    play.lastWall = wall;
    if (run.mode === 'realtime') {
      engine.runUntil(after(engine.now, ms(elapsed * play.speed)));
      return;
    }
    play.stepCredit = Math.min(
      play.stepCredit + (elapsed * play.speed) / 1000,
      MAX_STEPS_PER_FRAME,
    );
    for (; play.stepCredit >= 1; play.stepCredit -= 1) stepOnce();
  }

  function flush() {
    if (!listener) return;
    const head = engine.log.lastId;
    // A step back forgets events, so the next batch starts after the restored head.
    if (flushed > head) flushed = head;
    const status: Status = {
      now: engine.now,
      mode: run.mode,
      playing: playback.playing,
      head,
      canStepBack: run.mode === 'simulation' && run.history.canStepBack,
    };
    const events = engine.log.since(flushed);
    if (events.length === 0 && sent && sameStatus(sent, status)) return;
    flushed = head;
    sent = status;
    listener({ ...status, events, links: engine.linkStates() });
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

  function play(speed: number) {
    if (!Number.isFinite(speed) || speed <= 0) {
      throw new RangeError(`Speed must be a finite number > 0, got ${speed}`);
    }
    playback = { playing: true, speed, lastWall: frames.now(), stepCredit: 0 };
    requestFrame();
  }

  return {
    load(topology) {
      if (run.mode === 'simulation') run.history.dropFuture();
      engine.load(topology);
      flushed = 0 as EventId;
      if (run.mode === 'simulation') run = { mode: 'simulation', history: createHistory(engine) };
      requestFrame();
    },
    applyPatch(patch) {
      input({ apply: () => engine.applyPatch(patch) });
      requestFrame();
    },
    setMode(next) {
      if (next === run.mode) return;
      if (run.mode === 'simulation') {
        // Realtime carries on from the moment on screen. What was stepped back from never happens.
        run.history.dropFuture();
        run = { mode: 'realtime' };
        play(1);
        return;
      }
      playback = { playing: false };
      run = { mode: 'simulation', history: createHistory(engine) };
      requestFrame();
    },
    step() {
      playback = { playing: false };
      const mark = engine.log.lastId;
      stepOnce();
      requestFrame();
      return engine.log.since(mark);
    },
    stepBack() {
      if (run.mode !== 'simulation') return false;
      playback = { playing: false };
      const stepped = run.history.back();
      requestFrame();
      return stepped;
    },
    play,
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
      const once = hearOnce(target, listener);
      let started: ReturnType<SimAPI['ping']> | undefined;
      input({
        apply: () => {
          started = engine.withModule(device, ipModule, (ctx) =>
            startPing(ctx, target, options, once.listener),
          );
        },
        forget: once.forget,
      });
      requestFrame();
      return started!;
    },
    arpTable: (device) => engine.withModule(device, ipModule, arpTable),
    routes: (device) => engine.withModule(device, ipModule, (ctx) => routesOf(ctx).routes),
    macTable: (device) =>
      engine.withModule(device, switchingModule, (ctx) => macTable(ctx.state, ctx.now)),
    spanningTree: (device) =>
      engine.withModule(device, switchingModule, (ctx) => spanningTreeOf(ctx.device, ctx.state)),
    portStates: (device) =>
      engine.withModule(device, ipModule, (ctx) =>
        Object.fromEntries(ctx.device.ports.map((port) => [port.id, ctx.portUp(port.id)])),
      ),
    subscribe(next) {
      listener = next;
      sent = undefined;
      requestFrame();
    },
  };
}
