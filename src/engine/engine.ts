import { DEFAULT_LAB_SETTINGS, labSettings } from '@/model/defaults';
import type {
  Device,
  DeviceId,
  Endpoint,
  LabSettings,
  Link,
  LinkId,
  Topology,
  WirelessProfile,
} from '@/model';
import { err, ok, type Result } from '@/model/result';
import { associations, type ApBroadcasts, type Association } from '@/model/wireless';
import { cloneState } from './core/clone';
import { createEventLog, type EventLog } from './core/log';
import { createEventQueue, type QueueEntry, type SavedEntry } from './core/queue';
import { drawRandom } from './core/random';
import { after, ms, START, type SimDuration, type SimTime } from './core/time';
import type { EventId, SentFrame, SimEvent } from './events';
import type { Frame } from './frame';
import { linkSyslog, linkUp } from './l1';
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
  /**
   * Whether frames that reach a shared segment, such as a hub, at the same instant collide, as in
   * Packet Tracer's Simulation mode. Off, as in realtime, each arrives in turn.
   */
  detectCollisions(on: boolean): void;
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

/** A cable from the topology, or a host's association with a radio, which the devices imply. */
type SimLink = Link | Association;

type LinkState = { link: SimLink; up: boolean; generation: number };

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

const sameWiring = (left: SimLink, right: SimLink) =>
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
  // A cabled port has one link. A radio has one per client associated with it.
  const portLinks = new Map<string, LinkState[]>();
  const running = new Map<DeviceId, Slot[]>();
  let randomState = seed >>> 0;
  let now = START;
  let generations = 0;
  let settings = DEFAULT_LAB_SETTINGS;
  // Set while a lab loads, when links coming up are not news.
  let loading = false;
  // What the device handling an arriving frame sends, while it handles it.
  let handling: SentFrame[] | undefined;
  // The frame being handled and where it came from, so a radio relaying it skips its sender.
  let relaying: { frame: Frame; from: Endpoint } | undefined;
  let collisions = false;

  function random() {
    const draw = drawRandom(randomState);
    randomState = draw.state;
    return draw.value;
  }

  /**
   * Puts a frame on the port's link, or on each of a radio's associations: a radio is a medium its
   * clients share. A frame it relays never goes back to the client it heard the frame from.
   */
  function send(from: Endpoint, frame: Frame) {
    const states = portLinks.get(endpointKey(from));
    if (!states) return;
    handling?.push({ port: from.port, frame });
    for (const state of states) {
      const { link } = state;
      const to = sameEndpoint(link.a, from) ? link.b : link.a;
      const echo = relaying?.frame === frame && sameEndpoint(to, relaying.from);
      if (link.cable === 'wireless' && echo) continue;
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
        continue;
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
        portUp: (port) =>
          portLinks.get(endpointKey({ device: id, port }))?.some((state) => state.up) ?? false,
        forwards: (port, vlan) =>
          slot.ctx.portUp(port) &&
          !(running.get(id) ?? []).some((other) => other.module.holdsVlan?.(other.ctx, port, vlan)),
        bundleOf: (port) => {
          for (const other of running.get(id) ?? []) {
            const bundle = other.module.bundleOf?.(other.ctx, port);
            if (bundle !== undefined) return bundle;
          }
          return undefined;
        },
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
        syslog: (text) => syslog(id, text),
        learnSticky: (port, mac) =>
          log.append({ kind: 'sticky-mac', time: now, device: id, port, mac }),
        learnFiles: (service, files) =>
          log.append({ kind: 'server-files', time: now, device: id, service, files: [...files] }),
        learnThingState: (state) =>
          log.append({ kind: 'thing-state', time: now, device: id, state: { ...state } }),
        relink: () => relink((link) => link.a.device === id || link.b.device === id),
        reassociate: () => applyPatch({ devices: {}, links: {} }),
        storeVlans: (database) =>
          log.append({ kind: 'vlan-database', time: now, device: id, database }),
        forwardingChanged: () => {
          for (const other of running.get(id) ?? []) {
            // A module still booting reads the forwarding state when its init runs.
            if (other === slot || other.ctx.state === undefined) continue;
            other.module.onConfigChange?.(other.ctx);
          }
        },
        learnedRoutes: () =>
          (running.get(id) ?? []).flatMap((other) => other.module.routes?.(other.ctx) ?? []),
        virtualAddresses: () =>
          (running.get(id) ?? []).flatMap(
            (other) => other.module.virtualAddresses?.(other.ctx) ?? [],
          ),
      },
    };
    return slot;
  }

  /** Logs a console message and lets the device's modules hear it, as a logging host does. */
  function syslog(id: DeviceId, text: string) {
    log.append({ kind: 'syslog', time: now, device: id, text });
    for (const slot of running.get(id) ?? []) slot.module.onSyslog?.(slot.ctx, text);
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

  function linkChanged(link: SimLink, up: boolean) {
    log.append({ kind: 'link', time: now, link: link.id, up });
    // Devices booting with a lab print nothing: their consoles open on a running network.
    if (!loading) {
      for (const end of [link.a, link.b]) {
        for (const text of linkSyslog(devices.get(end.device), end.port, up, disabled(end))) {
          syslog(end.device, text);
        }
      }
    }
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
  function linkTransitions(chosen: (link: SimLink) => boolean): [SimLink, boolean][] {
    const transitions: [SimLink, boolean][] = [];
    for (const state of links.values()) {
      if (!chosen(state.link)) continue;
      const { a, b } = state.link;
      const up =
        linkUp(state.link, devices.get(a.device), devices.get(b.device)) &&
        !disabled(a) &&
        !disabled(b);
      if (up === state.up) continue;
      state.up = up;
      if (up) state.generation = ++generations;
      transitions.push([state.link, up]);
    }
    return transitions;
  }

  function relink(chosen: (link: SimLink) => boolean) {
    for (const [link, up] of linkTransitions(chosen)) linkChanged(link, up);
  }

  function indexPorts() {
    portLinks.clear();
    for (const state of links.values()) {
      for (const end of [state.link.a, state.link.b]) {
        const key = endpointKey(end);
        portLinks.set(key, [...(portLinks.get(key) ?? []), state]);
      }
    }
  }

  /** What each running lightweight AP broadcasts now, as its modules say. */
  function apBroadcasts(): ApBroadcasts {
    const found: Partial<Record<DeviceId, readonly WirelessProfile[]>> = {};
    for (const [id, slots] of running) {
      for (const slot of slots) {
        const networks =
          slot.ctx.state === undefined ? undefined : slot.module.broadcasts?.(slot.ctx);
        if (networks) found[id] = networks;
      }
    }
    return found;
  }

  /** The associations the devices make now, and those that ended, as a patch to the links. */
  function wirelessPatch(): Record<LinkId, Association | null> {
    const wanted = associations(devices.values(), apBroadcasts());
    const patch: Record<LinkId, Association | null> = {};
    for (const [id, state] of links) if (state.link.cable === 'wireless') patch[id] = null;
    for (const association of wanted) patch[association.id] = association;
    return patch;
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

    const transitions: [SimLink, boolean][] = [];
    const changes = { ...patch.links, ...wirelessPatch() };
    for (const [id, next] of Object.entries(changes) as [LinkId, SimLink | null][]) {
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
    loading = true;
    try {
      applyPatch({ devices: topology.devices, links: topology.links });
    } finally {
      loading = false;
    }
  }

  type Arrival = Extract<Scheduled, { kind: 'arrival' }>;

  function deliverable(item: Arrival) {
    const state = links.get(item.link);
    return state?.up === true && state.generation === item.generation;
  }

  /**
   * The frames that collide with `item` on a shared segment: those reaching another port of its
   * device at this same instant. They leave the queue, since none of them arrives.
   */
  function rivals(item: Arrival): Arrival[] {
    const device = devices.get(item.to.device);
    if (!collisions || !device || !stacks[device.kind].some((module) => module.sharedMedium)) {
      return [];
    }
    const taken = queue.take(
      ({ time, value }) =>
        time === now &&
        value.kind === 'arrival' &&
        value.to.device === item.to.device &&
        value.to.port !== item.to.port &&
        deliverable(value),
    );
    return taken.map((entry) => entry.value as Arrival);
  }

  function process(item: Scheduled) {
    switch (item.kind) {
      case 'arrival': {
        const delivered = deliverable(item);
        const collided = delivered ? rivals(item) : [];
        if (collided.length > 0) {
          for (const { link, from, to, frame, sentAt } of [item, ...collided]) {
            log.append({
              kind: 'frame',
              time: now,
              sentAt,
              link,
              from,
              to,
              frame,
              outcome: 'collision',
            });
          }
          return;
        }
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
        relaying = { frame, from };
        for (const slot of running.get(to.device) ?? []) {
          slot.module.onFrame?.(slot.ctx, to.port, frame);
        }
        handling = undefined;
        relaying = undefined;
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
    detectCollisions: (on) => {
      collisions = on;
    },
  };
}
