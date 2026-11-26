import { DEFAULT_LAB_SETTINGS, labSettings } from '@/model/defaults';
import type { Device, DeviceId, Endpoint, LabSettings, Link, LinkId, Topology } from '@/model';
import { err, ok, type Result } from '@/model/result';
import { cloneState } from './core/clone';
import { createEventLog, type EventLog } from './core/log';
import { createEventQueue, type QueueEntry, type SavedEntry } from './core/queue';
import { drawRandom } from './core/random';
import { after, ms, START, type SimDuration, type SimTime } from './core/time';
import type { EventId, SentFrame, SimEvent } from './events';
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
  /** What each end of each link in the simulation is doing now. */
  linkStates(): Record<LinkId, LinkStatus>;
  /** Everything the run depends on now, so `restore` can return to this moment. */
  snapshot(): EngineSnapshot;
  /**
   * Puts the run back to a snapshot it took. Its log forgets the events logged since, and no
   * module hook runs, so nothing outside the engine hears about it.
   */
  restore(snapshot: EngineSnapshot): void;
};

/** A timer entry names its slot by device and stack position, since slots are rebuilt. */
type SavedScheduled =
  | Exclude<Scheduled, { kind: 'timer' }>
  | { kind: 'timer'; device: DeviceId; slot: number; key: string };

/** A run frozen at one moment. Treat it as opaque: only the engine that took it reads it. */
export type EngineSnapshot = {
  readonly now: SimTime;
  /** The newest event logged when it was taken. */
  readonly head: EventId;
  readonly random: number;
  readonly generations: number;
  readonly settings: LabSettings;
  readonly devices: ReadonlyMap<DeviceId, Device>;
  readonly links: readonly Readonly<LinkState>[];
  readonly running: ReadonlyMap<DeviceId, readonly { module: SimModule; state: unknown }[]>;
  readonly queue: { entries: readonly SavedEntry<SavedScheduled>[]; seq: number };
};

/** One end of a link: down, up, or up but held back from forwarding, as by spanning tree. */
export type LinkEnd = 'down' | 'up' | 'held';

/** Both ends of a link. A link that is down is down at both. */
export type LinkStatus = { readonly a: LinkEnd; readonly b: LinkEnd };

const LINK_DOWN: LinkStatus = { a: 'down', b: 'down' };

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
  let randomState = seed >>> 0;
  let now = START;
  let generations = 0;
  let settings = DEFAULT_LAB_SETTINGS;
  // What the device handling an arriving frame sends, while it handles it.
  let handling: SentFrame[] | undefined;

  function random() {
    const draw = drawRandom(randomState);
    randomState = draw.state;
    return draw.value;
  }

  function send(from: Endpoint, frame: Frame) {
    const state = portLinks.get(endpointKey(from));
    if (!state) return;
    const { link } = state;
    const to = sameEndpoint(link.a, from) ? link.b : link.a;
    handling?.push({ port: from.port, frame });
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
        get settings() {
          return settings;
        },
        portUp: (port) => portLinks.get(endpointKey({ device: id, port }))?.up ?? false,
        forwards: (port, vlan) =>
          slot.ctx.portUp(port) &&
          !(running.get(id) ?? []).some((other) => other.module.holdsVlan?.(other.ctx, port, vlan)),
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
        random,
        note: (text) =>
          log.append({ kind: 'note', time: now, device: id, module: module.id, text }),
        syslog: (text) => log.append({ kind: 'syslog', time: now, device: id, text }),
        learnSticky: (port, mac) =>
          log.append({ kind: 'sticky-mac', time: now, device: id, port, mac }),
        relink: () => relink((link) => link.a.device === id || link.b.device === id),
        learnedRoutes: () =>
          (running.get(id) ?? []).flatMap((other) => other.module.routes?.(other.ctx) ?? []),
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

  /** Whether a module on the device has taken the port down, as by err-disabling it. */
  function disabled({ device, port }: Endpoint) {
    return (running.get(device) ?? []).some((slot) => slot.module.disablesPort?.(slot.ctx, port));
  }

  /** Brings the chosen links up or down as their ends allow, and returns those that changed. */
  function linkTransitions(chosen: (link: Link) => boolean): [Link, boolean][] {
    const transitions: [Link, boolean][] = [];
    for (const state of links.values()) {
      if (!chosen(state.link)) continue;
      const { a, b, cable } = state.link;
      const up =
        endUp(devices.get(a.device), a.port, cable) &&
        endUp(devices.get(b.device), b.port, cable) &&
        !disabled(a) &&
        !disabled(b);
      if (up === state.up) continue;
      state.up = up;
      if (up) state.generation = ++generations;
      transitions.push([state.link, up]);
    }
    return transitions;
  }

  function relink(chosen: (link: Link) => boolean) {
    for (const [link, up] of linkTransitions(chosen)) linkChanged(link, up);
  }

  function indexPorts() {
    portLinks.clear();
    for (const state of links.values()) {
      portLinks.set(endpointKey(state.link.a), state);
      portLinks.set(endpointKey(state.link.b), state);
    }
  }

  function applyPatch(patch: TopologyPatch) {
    const touched = Object.keys(patch.devices) as DeviceId[];
    const nextSettings = patch.settings;
    const settingsChanged =
      nextSettings !== undefined &&
      (Object.keys(nextSettings) as (keyof LabSettings)[]).some(
        (key) => nextSettings[key] !== settings[key],
      );
    if (nextSettings) settings = nextSettings;
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
    indexPorts();

    for (const id of touched) if (running.has(id) && !devices.get(id)?.powered) stop(id);

    transitions.push(...linkTransitions(() => true));
    for (const [link, up] of transitions) linkChanged(link, up);

    for (const id of touched) {
      const device = devices.get(id);
      if (!device?.powered) continue;
      const slots = running.get(id);
      if (!slots) start(device);
      else for (const slot of slots) slot.module.onConfigChange?.(slot.ctx);
    }
    if (!settingsChanged) return;
    for (const [id, slots] of running) {
      if (touched.includes(id)) continue;
      for (const slot of slots) slot.module.onConfigChange?.(slot.ctx);
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
    randomState = seed >>> 0;
    now = START;
    generations = 0;
    settings = labSettings(topology);
    applyPatch({ devices: topology.devices, links: topology.links });
  }

  function process(item: Scheduled) {
    switch (item.kind) {
      case 'arrival': {
        const state = links.get(item.link);
        const delivered = state?.up === true && state.generation === item.generation;
        const { link, from, to, frame, sentAt } = item;
        // The device's sends fill in `sent` as it handles the frame, before the event leaves
        // the engine.
        const sent: SentFrame[] = [];
        log.append({
          kind: 'frame',
          time: now,
          sentAt,
          link,
          from,
          to,
          frame,
          outcome: delivered ? 'delivered' : 'link-down',
          ...(delivered && { sent }),
        });
        if (!delivered) return;
        handling = sent;
        for (const slot of running.get(to.device) ?? []) {
          slot.module.onFrame?.(slot.ctx, to.port, frame);
        }
        handling = undefined;
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

  function snapshot(): EngineSnapshot {
    const places = new Map<Slot, { device: DeviceId; slot: number }>();
    const saved = new Map<DeviceId, { module: SimModule; state: unknown }[]>();
    for (const [device, slots] of running) {
      slots.forEach((slot, index) => places.set(slot, { device, slot: index }));
      saved.set(
        device,
        slots.map((slot) => ({ module: slot.module, state: cloneState(slot.ctx.state) })),
      );
    }
    const { entries, seq } = queue.save();
    return {
      now,
      head: log.lastId,
      random: randomState,
      generations,
      settings,
      devices: new Map(devices),
      links: [...links.values()].map((state) => ({ ...state })),
      running: saved,
      queue: {
        seq,
        entries: entries.map(({ time, seq, value }) => ({
          time,
          seq,
          value:
            value.kind === 'timer'
              ? { ...places.get(value.slot)!, kind: 'timer', key: value.key }
              : value,
        })),
      },
    };
  }

  function restore(saved: EngineSnapshot) {
    devices.clear();
    for (const [id, device] of saved.devices) devices.set(id, device);
    links.clear();
    for (const state of saved.links) links.set(state.link.id, { ...state });
    indexPorts();

    running.clear();
    for (const [id, images] of saved.running) {
      const slots = images.map(({ module, state }) => {
        const slot = createSlot(id, module);
        slot.ctx.state = cloneState(state);
        return slot;
      });
      running.set(id, slots);
    }

    const entries = saved.queue.entries.map(({ time, seq, value }) => ({
      time,
      seq,
      value:
        value.kind === 'timer'
          ? ({
              kind: 'timer',
              slot: running.get(value.device)![value.slot]!,
              key: value.key,
            } as const)
          : value,
    }));
    for (const entry of queue.restore(entries, saved.queue.seq)) {
      if (entry.value.kind === 'timer') entry.value.slot.timers.set(entry.value.key, entry);
    }

    now = saved.now;
    randomState = saved.random;
    generations = saved.generations;
    settings = saved.settings;
    log.truncate(saved.head);
  }

  function endOf(end: Endpoint): LinkEnd {
    const slots = running.get(end.device) ?? [];
    return slots.some((slot) => slot.module.holdsPort?.(slot.ctx, end.port)) ? 'held' : 'up';
  }

  function linkStates(): Record<LinkId, LinkStatus> {
    const states = [...links].map(([id, { link, up }]): [LinkId, LinkStatus] => [
      id,
      up ? { a: endOf(link.a), b: endOf(link.b) } : LINK_DOWN,
    ]);
    return Object.fromEntries(states) as Record<LinkId, LinkStatus>;
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
    snapshot,
    restore,
    linkStates,
  };
}
