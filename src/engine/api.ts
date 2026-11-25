import type { DeviceId, Ipv4Address, LinkId, PortId, Result, Topology } from '@/model';
import type { SimTime } from './core/time';
import type { LinkEnd, LinkStatus } from './engine';
import type { EventId, SimEvent } from './events';
import type { MacTableEntry, SpanningTreeVlan } from './l2/switching';
import type { PortRole, PortState, SpanningTreePort, StpTimes } from './l2/stp';
import type { ArpTableEntry } from './l3/arp';
import type { PingEvent, PingListener, PingOptions, PingReply, PingSummary } from './l3/ping';
import type { Route } from './l3/routes';
import type { DeviceUnavailable } from './module';
import type { TopologyPatch } from './patch';

export type {
  ArpTableEntry,
  DeviceUnavailable,
  LinkEnd,
  LinkStatus,
  MacTableEntry,
  PingEvent,
  PingListener,
  PingOptions,
  PingReply,
  PingSummary,
  PortRole,
  PortState,
  Route,
  SpanningTreePort,
  SpanningTreeVlan,
  StpTimes,
};

export type SimMode = 'realtime' | 'simulation';

/** What the worker sends once per animation frame when something changed. */
export type SimEventBatch = {
  now: SimTime;
  mode: SimMode;
  playing: boolean;
  /**
   * What was logged since the previous batch. Ids are positions in the run: after a step back,
   * replayed events reuse their ids, so an event replaces any held event with the same id.
   */
  events: SimEvent[];
  /** The newest event's id. Lower than before after a step back: later events no longer happened. */
  head: EventId;
  /** Simulation mode only: whether `stepBack` has a moment to return to. */
  canStepBack: boolean;
  /** What each end of each link is doing. Every batch carries them all, so one is enough to draw them. */
  links: Record<LinkId, LinkStatus>;
};

export type CliResult = { kind: 'not-implemented' };

/** The simulation worker's contract with the main thread. */
export interface SimAPI {
  /** Starts a new run from this topology: the clock, the queue, the log and the seed all reset. */
  load(topology: Topology): void;
  applyPatch(patch: TopologyPatch): void;
  /**
   * Switches mode; the current mode again changes nothing. Simulation pauses the clock and starts
   * a history at this moment, which step back can return to. Realtime carries on from the moment
   * on screen at wall-clock speed, and forgets any future that was stepped back from.
   */
  setMode(mode: SimMode): void;
  /**
   * Pauses, then runs the next instant that logs something: every queued event at that simulated
   * time, so each packet in flight moves one hop. Returns what it logged.
   */
  step(): SimEvent[];
  /**
   * Simulation mode: pauses and returns to the moment before the last step, by restoring the
   * nearest snapshot and replaying. Stepping forward again replays the same events with the same
   * ids. Returns false at the start of the history, and in Realtime mode.
   */
  stepBack(): boolean;
  /**
   * Realtime: `speed` simulated ms per wall-clock ms, so 1 tracks the wall clock.
   * Simulation: `speed` logged steps per second.
   */
  play(speed: number): void;
  pause(): void;
  runCommand(device: DeviceId, line: string): CliResult;
  /**
   * Pings `target` from a router or host in simulated time: `count` echo requests about a second
   * apart, each waiting up to `timeoutMs`. Each request's fate, then a summary, goes to `listener`
   * as the simulation runs; nothing arrives while it is paused. The listener hears each fate once
   * even when stepping back replays it, and a ping that a step back un-starts ends with a summary
   * of what it heard. Throws a RangeError for a count that is not a whole number >= 1 or a timeout
   * that is not > 0.
   */
  ping(
    device: DeviceId,
    target: Ipv4Address,
    options: PingOptions,
    listener: PingListener,
  ): Result<void, DeviceUnavailable>;
  /** A router or host's own Ethernet addresses and the ones it has learned, by address. */
  arpTable(device: DeviceId): Result<ArpTableEntry[], DeviceUnavailable>;
  /** The routes a router or host uses now, by network, for `show ip route`. */
  routes(device: DeviceId): Result<Route[], DeviceUnavailable>;
  /** The addresses a switch has learned and not yet aged out, by VLAN then MAC. */
  macTable(device: DeviceId): Result<MacTableEntry[], DeviceUnavailable>;
  /** A switch's spanning tree instances, by VLAN, for `show spanning-tree`. */
  spanningTree(device: DeviceId): Result<SpanningTreeVlan[], DeviceUnavailable>;
  /** Whether each of a device's ports has its link up now, for interface status in `show`. */
  portStates(device: DeviceId): Result<Record<PortId, boolean>, DeviceUnavailable>;
  /** Sets the one batch listener. Calling it again replaces the previous listener. */
  subscribe(listener: (batch: SimEventBatch) => void): void;
}
