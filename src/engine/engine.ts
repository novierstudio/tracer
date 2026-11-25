import {
  err,
  ok,
  type Device,
  type DeviceId,
  type Endpoint,
  type Link,
  type LinkId,
  type Result,
  type Topology,
} from '@/model';
import { createEventLog, type EventLog } from './core/log';
import { createEventQueue, type QueueEntry } from './core/queue';
import { createRandom } from './core/random';
import { after, ms, START, type SimDuration, type SimTime } from './core/time';
import type { SimEvent } from './events';
import type { Frame } from './frame';
import { endUp } from './l1';
import type { DeviceUnavailable, ModuleContext, SimModule, Stacks } from './module';
import type { TopologyPatch } from './patch';

export type EngineOptions = {
  seed: number;
  stacks: Stacks;
  linkDelay?: SimDuration;
  logCapacity?: number;
};

export type Engine = {
  readonly now: SimTime;
  readonly log: EventLog;
  load(topology: Topology): void;
  applyPatch(patch: TopologyPatch): void;
  nextTime(): SimTime | undefined;
  /** Processes the next queued event and returns what it logged. */
  step(): SimEvent[];
  /** Processes every event up to and including `time`, then moves the clock to `time`. */
  runUntil(time: SimTime): SimEvent[];
  /**
   * Runs `run` with the context of `module` on a running device, at the current time. What it
   * sends or schedules counts as the module's own doing. Commands and queries reach devices this way.
   */
  withModule<S, R>(
    device: DeviceId,
    module: SimModule<S>,
    run: (ctx: ModuleContext<S>) => R,
  ): Result<R, DeviceUnavailable>;
  /** Whether each link in the simulation is up now. */
  linkStates(): Record<LinkId, boolean>;
};

type Slot = {
  module: SimModule;
  ctx: ModuleContext<unknown>;
  timers: Map<string, QueueEntry<Scheduled>>;
};

type LinkState = { link: Link; up: boolean; generation: number };

type Scheduled =
  | {
      kind: 'arrival';
      link: LinkId;
      generation: number;
      from: Endpoint;
      to: Endpoint;
      frame: Frame;
      sentAt: SimTime;
    }
  | { kind: 'timer'; slot: Slot; key: string };

const endpointKey = ({ device, port }: Endpoint) => `${device} ${port}`;

const sameEndpoint = (left: Endpoint, right: Endpoint) =>
  left.device === right.device && left.port === right.port;

const sameWiring = (left: Link, right: Link) =>
  left.cable === right.cable && sameEndpoint(left.a, right.a) && sameEndpoint(left.b, right.b);

export function createEngine({
  seed,
  stacks,
  linkDelay = ms(1),
  logCapacity = 10_000,
}: EngineOptions): Engine {
  const queue = createEventQueue<Scheduled>();
  const log = createEventLog(logCapacity);
  const devices = new Map<DeviceId, Device>();
  const links = new Map<LinkId, LinkState>();
  const portLinks = new Map<string, LinkState>();
  const running = new Map<DeviceId, Slot[]>();
  let random = createRandom(seed);
  let now = START;
  let generations = 0;

  function send(from: Endpoint, frame: Frame) {
    const state = portLinks.get(endpointKey(from));
    if (!state) return;
    const { link } = state;
    const to = sameEndpoint(link.a, from) ? link.b : link.a;
    if (!state.up) {
      log.append({
        kind: 'frame',
        time: now,
        sentAt: now,
        link: link.id,
        from,
        to,
        frame,
        outcome: 'link-down',
      });
      return;
    }
    queue.push(after(now, linkDelay), {
      kind: 'arrival',
      link: link.id,
      generation: state.generation,
      from,
      to,
      frame,
      sentAt: now,
    });
  }

  function createSlot(id: DeviceId, module: SimModule): Slot {
    const slot: Slot = {
      module,
      timers: new Map(),
      ctx: {
        state: undefined,
        get now() {
          return now;
        },
        get device() {
          const device = devices.get(id);
          if (!device) throw new Error(`Device ${id} is not in the simulation`);
          return device;
        },
        portUp: (port) => portLinks.get(endpointKey({ device: id, port }))?.up ?? false,
        send: (port, frame) => send({ device: id, port }, frame),
        setTimer: (key, delay) => {
          const pending = slot.timers.get(key);
          if (pending) queue.cancel(pending);
          slot.timers.set(key, queue.push(after(now, delay), { kind: 'timer', slot, key }));
        },
        clearTimer: (key) => {
          const pending = slot.timers.get(key);
          if (!pending) return;
          queue.cancel(pending);
          slot.timers.delete(key);
        },
        random: () => random(),
        note: (text) =>
          log.append({ kind: 'note', time: now, device: id, module: module.id, text }),
      },
    };
    return slot;
  }

  function start(device: Device) {
    const slots = stacks[device.kind].map((module) => createSlot(device.id, module));
    running.set(device.id, slots);
    for (const slot of slots) slot.ctx.state = slot.module.init(slot.ctx);
  }

  function stop(id: DeviceId) {
    for (const slot of running.get(id) ?? []) {
      slot.module.onStop?.(slot.ctx);
      for (const pending of slot.timers.values()) queue.cancel(pending);
    }
    running.delete(id);
  }

  function linkChanged(link: Link, up: boolean) {
    log.append({ kind: 'link', time: now, link: link.id, up });
    for (const end of [link.a, link.b]) {
      for (const slot of running.get(end.device) ?? []) {
        slot.module.onLinkChange?.(slot.ctx, end.port, up);
      }
    }
  }

  function applyPatch(patch: TopologyPatch) {
    const touched = Object.keys(patch.devices) as DeviceId[];
    for (const id of touched) {
      const next = patch.devices[id];
      if (next) devices.set(id, next);
      else devices.delete(id);
    }

    const transitions: [Link, boolean][] = [];
    for (const [id, next] of Object.entries(patch.links) as [LinkId, Link | null][]) {
      const current = links.get(id);
      if (current?.up && !(next && sameWiring(current.link, next))) {
        transitions.push([current.link, false]);
      }
      if (!next) links.delete(id);
      else if (current && sameWiring(current.link, next)) current.link = next;
      else links.set(id, { link: next, up: false, generation: 0 });
    }
    portLinks.clear();
    for (const state of links.values()) {
      portLinks.set(endpointKey(state.link.a), state);
      portLinks.set(endpointKey(state.link.b), state);
    }

    for (const id of touched) if (running.has(id) && !devices.get(id)?.powered) stop(id);

    for (const state of links.values()) {
      const { a, b, cable } = state.link;
      const up =
        endUp(devices.get(a.device), a.port, cable) && endUp(devices.get(b.device), b.port, cable);
      if (up === state.up) continue;
      state.up = up;
      if (up) state.generation = ++generations;
      transitions.push([state.link, up]);
    }
    for (const [link, up] of transitions) linkChanged(link, up);

    for (const id of touched) {
      const device = devices.get(id);
      if (!device?.powered) continue;
      const slots = running.get(id);
      if (!slots) start(device);
      else for (const slot of slots) slot.module.onConfigChange?.(slot.ctx);
    }
  }

  function load(topology: Topology) {
    for (const id of [...running.keys()]) stop(id);
    queue.clear();
    log.clear();
    devices.clear();
    links.clear();
    portLinks.clear();
    running.clear();
    random = createRandom(seed);
    now = START;
    generations = 0;
    applyPatch({ devices: topology.devices, links: topology.links });
  }

  function process(item: Scheduled) {
    switch (item.kind) {
      case 'arrival': {
        const state = links.get(item.link);
        const delivered = state?.up === true && state.generation === item.generation;
        const { link, from, to, frame, sentAt } = item;
        log.append({
          kind: 'frame',
          time: now,
          sentAt,
          link,
          from,
          to,
          frame,
          outcome: delivered ? 'delivered' : 'link-down',
        });
        if (!delivered) return;
        for (const slot of running.get(to.device) ?? []) {
          slot.module.onFrame?.(slot.ctx, to.port, frame);
        }
        return;
      }
      case 'timer':
        item.slot.timers.delete(item.key);
        item.slot.module.onTimer?.(item.slot.ctx, item.key);
        return;
      default: {
        const exhaustive: never = item;
        return exhaustive;
      }
    }
  }

  function step(): SimEvent[] {
    const mark = log.lastId;
    const entry = queue.pop();
    if (!entry) return [];
    now = entry.time;
    process(entry.value);
    return log.since(mark);
  }

  function runUntil(time: SimTime): SimEvent[] {
    const mark = log.lastId;
    for (let next = queue.peek(); next && next.time <= time; next = queue.peek()) {
      queue.pop();
      now = next.time;
      process(next.value);
    }
    if (time > now) now = time;
    return log.since(mark);
  }

  function withModule<S, R>(
    id: DeviceId,
    module: SimModule<S>,
    run: (ctx: ModuleContext<S>) => R,
  ): Result<R, DeviceUnavailable> {
    const device = devices.get(id);
    if (!device) return err('unknown-device');
    if (!device.powered) return err('powered-off');
    const slot = running.get(id)?.find((candidate) => candidate.module === module);
    if (!slot) return err('unsupported');
    // The slot was booted by this very module, so its state is the module's S.
    return ok(run(slot.ctx as ModuleContext<S>));
  }

  return {
    get now() {
      return now;
    },
    log,
    load,
    applyPatch,
    nextTime: () => queue.peek()?.time,
    step,
    runUntil,
    withModule,
    linkStates: () =>
      Object.fromEntries([...links].map(([id, state]) => [id, state.up])) as Record<
        LinkId,
        boolean
      >,
  };
}
