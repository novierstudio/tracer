import type { DeviceId, Ipv4Address, LinkId, Result, Topology } from '@/model';
import type { SimTime } from './core/time';
import type { SimEvent } from './events';
import type { MacTableEntry } from './l2/switching';
import type { ArpTableEntry } from './l3/arp';
import type { PingEvent, PingListener, PingOptions, PingReply, PingSummary } from './l3/ping';
import type { Route } from './l3/routes';
import type { DeviceUnavailable } from './module';
import type { TopologyPatch } from './patch';

export type {
  ArpTableEntry,
  DeviceUnavailable,
  MacTableEntry,
  PingEvent,
  PingListener,
  PingOptions,
  PingReply,
  PingSummary,
  Route,
};

export type SimMode = 'realtime' | 'simulation';

/** What the worker sends once per animation frame when something changed. */
export type SimEventBatch = {
  now: SimTime;
  mode: SimMode;
  playing: boolean;
  events: SimEvent[];
  /** Whether each link is up. Every batch carries them all, so one batch is enough to draw them. */
  links: Record<LinkId, boolean>;
};

export type CliResult = { kind: 'not-implemented' };

/** The simulation worker's contract with the main thread. */
export interface SimAPI {
  /** Starts a new run from this topology: the clock, the queue, the log and the seed all reset. */
  load(topology: Topology): void;
  applyPatch(patch: TopologyPatch): void;
  /** Switches mode. Either mode starts paused. */
  setMode(mode: SimMode): void;
  /** Pauses, then runs until the next event that logs something. Returns what it logged. */
  step(): SimEvent[];
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
   * as the simulation runs; nothing arrives while it is paused. Throws a RangeError for a count
   * that is not a whole number >= 1 or a timeout that is not > 0.
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
  /** Sets the one batch listener. Calling it again replaces the previous listener. */
  subscribe(listener: (batch: SimEventBatch) => void): void;
}
