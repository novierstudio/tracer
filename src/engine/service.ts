import { err, ok, type DeviceId, type Result } from '@/model';
import type {
  DeviceUnavailable,
  DhcpOutcome,
  PingEvent,
  ProbeHandle,
  SimAPI,
  SimEventBatch,
  TraceEvent,
} from './api';
import { after, ms } from './core/time';
import type { Engine } from './engine';
import type { EventId } from './events';
import { createHistory, stepInstant, type History, type Input } from './history';
import { macTable, spanningTreeOf, switchingModule } from './l2/switching';
import { arpTable, clearArp } from './l3/arp';
import { hostAddressingOf, routesOf, type IpContext } from './l3/context';
import { releaseDhcp, renewDhcp } from './l3/dhcpClient';
import { dhcpBindings } from './l3/dhcpServer';
import { ipModule, stopProbe } from './l3/ip';
import { pingSummary, startPing } from './l3/ping';
import { startTrace } from './l3/traceroute';

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
 * Wraps a listener so it hears each event once, however often stepping back replays it. `order`
 * places an event in the run, Infinity for the last one. If the history forgets the run, the
 * listener hears `ending`, the last event as it would be after what it heard.
 */
function hearOnce<E>(
  listener: (event: E) => void,
  order: (event: E) => number,
  ending: (heard: readonly E[]) => E,
) {
  let last = 0;
  const heard: E[] = [];
  const once = (event: E) => {
    const at = order(event);
    if (at <= last) return;
    last = at;
    heard.push(event);
    listener(event);
  };
  return {
    listener: once,
    forget() {
      if (last !== Infinity) once(ending(heard));
    },
  };
}

const pingOrder = (event: PingEvent) => (event.kind === 'summary' ? Infinity : event.seq);

const traceOrder = (probesPerHop: number) => (event: TraceEvent) =>
  event.kind === 'done' ? Infinity : (event.hop - 1) * probesPerHop + event.probe;

/** A result whose value says the device cannot answer, folded into its error. */
function flatten<T>(
  result: Result<T | undefined, DeviceUnavailable>,
): Result<T, DeviceUnavailable> {
  if (!result.ok) return result;
  return result.value === undefined ? err('unsupported') : ok(result.value);
}

function checkCount(name: string, count: number) {
  if (!Number.isInteger(count) || count < 1) {
    throw new RangeError(`${name} must be a whole number >= 1, got ${count}`);
  }
}

function checkTimeout(timeoutMs: number) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError(`Timeout must be a finite number of milliseconds > 0, got ${timeoutMs}`);
  }
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
  /** How to cancel each ping and traceroute that has not ended. */
  const cancels = new Map<ProbeHandle, () => void>();
  let nextHandle = 1;

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

  /**
   * Starts a ping or traceroute on `device` as an input, so a replay starts it again, and returns
   * the handle that cancels it. `start` returns the run's id in the device's IP stack.
   */
  function startProbe<E>(
    device: DeviceId,
    listener: (event: E) => void,
    order: (event: E) => number,
    ending: (heard: readonly E[]) => E,
    start: (ctx: IpContext, listener: (event: E) => void) => number,
  ): Result<ProbeHandle, DeviceUnavailable> {
    const handle = nextHandle++ as ProbeHandle;
    const once = hearOnce(
      (event: E) => {
        if (order(event) === Infinity) cancels.delete(handle);
        listener(event);
      },
      order,
      ending,
    );
    let id = 0;
    let started: Result<void, DeviceUnavailable> | undefined;
    input({
      apply: () => {
        started = engine.withModule(
          device,
          ipModule,
          (ctx) => void (id = start(ctx, once.listener)),
        );
      },
      forget: once.forget,
    });
    requestFrame();
    if (!started!.ok) return started!;
    cancels.set(handle, () => {
      input({ apply: () => void engine.withModule(device, ipModule, (ctx) => stopProbe(ctx, id)) });
      requestFrame();
    });
    return ok(handle);
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
      if (options.count !== Infinity) checkCount('Count', options.count);
      checkTimeout(options.timeoutMs);
      return startProbe(
        device,
        listener,
        pingOrder,
        (heard) =>
          pingSummary(
            target,
            heard.length,
            heard.flatMap((event) => (event.kind === 'reply' ? [event.timeMs] : [])),
          ),
        (ctx, once) => startPing(ctx, target, options, once),
      );
    },
    traceroute(device, target, options, listener) {
      checkCount('Max hops', options.maxHops);
      checkCount('Probes per hop', options.probesPerHop);
      checkTimeout(options.timeoutMs);
      return startProbe(
        device,
        listener,
        traceOrder(options.probesPerHop),
        (): TraceEvent => ({ kind: 'done' }),
        (ctx, once) => startTrace(ctx, target, options, once),
      );
    },
    cancel(handle) {
      cancels.get(handle)?.();
    },
    clearArp(device, address) {
      let cleared: Result<number, DeviceUnavailable> | undefined;
      input({
        apply: () => {
          cleared = engine.withModule(device, ipModule, (ctx) => clearArp(ctx, address));
        },
      });
      requestFrame();
      return cleared!;
    },
    arpTable: (device) => engine.withModule(device, ipModule, arpTable),
    routes: (device) => engine.withModule(device, ipModule, (ctx) => routesOf(ctx).routes),
    macTable: (device) =>
      engine.withModule(device, switchingModule, (ctx) => macTable(ctx.state, ctx.now)),
    spanningTree: (device) =>
      engine.withModule(device, switchingModule, (ctx) =>
        spanningTreeOf(ctx.device, ctx.state, ctx.settings),
      ),
    portStates: (device) =>
      engine.withModule(device, ipModule, (ctx) =>
        Object.fromEntries(ctx.device.ports.map((port) => [port.id, ctx.portUp(port.id)])),
      ),
    hostIp: (device) => flatten(engine.withModule(device, ipModule, hostAddressingOf)),
    dhcpBindings: (device) =>
      flatten(
        engine.withModule(device, ipModule, (ctx) =>
          ctx.device.kind === 'router' ? dhcpBindings(ctx) : undefined,
        ),
      ),
    dhcpRenew(device, listener) {
      const once = hearOnce<DhcpOutcome>(
        listener,
        () => Infinity,
        () => ({ kind: 'failed' }),
      );
      let started: Result<void, DeviceUnavailable> | undefined;
      input({
        apply: () => {
          started = engine.withModule(device, ipModule, (ctx) => renewDhcp(ctx, once.listener));
        },
        forget: once.forget,
      });
      requestFrame();
      return started!;
    },
    dhcpRelease(device) {
      let released: Result<void, DeviceUnavailable> | undefined;
      input({ apply: () => void (released = engine.withModule(device, ipModule, releaseDhcp)) });
      requestFrame();
      return released!;
    },
    subscribe(next) {
      listener = next;
      sent = undefined;
      requestFrame();
    },
  };
}
