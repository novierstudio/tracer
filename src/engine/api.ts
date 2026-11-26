import type { DeviceId, Ipv4Address, LinkId, PortId, Result, Topology } from '@/model';
import type { SimTime } from './core/time';
import type { LinkEnd, LinkStatus } from './engine';
import type { EventId, SimEvent } from './events';
import type { MacTableEntry, SpanningTreeVlan } from './l2/switching';
import type { PortRole, PortState, SpanningTreePort, StpTimes } from './l2/stp';
import type { ArpTableEntry } from './l3/arp';
import type { DhcpListener, DhcpOutcome, Lease } from './l3/dhcpClient';
import type { DhcpBindingEntry } from './l3/dhcpServer';
import type { HostAddressing } from './l3/hostAddress';
import type { PingEvent, PingListener, PingOptions, PingReply, PingSummary } from './l3/ping';
import type { LearnedRoute, Route } from './l3/routes';
import type { TraceEvent, TraceListener, TraceOptions, TraceProbe } from './l3/traceroute';
import type { DeviceUnavailable } from './module';
import type { RipStatus } from './routing/rip';
import type { RipTimers } from './routing/timers';
import type { TopologyPatch } from './patch';

export type {
  ArpTableEntry,
  DeviceUnavailable,
  DhcpBindingEntry,
  DhcpListener,
  DhcpOutcome,
  HostAddressing,
  LearnedRoute,
  Lease,
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
  RipStatus,
  RipTimers,
  Route,
  SpanningTreePort,
  SpanningTreeVlan,
  StpTimes,
  TraceEvent,
  TraceListener,
  TraceOptions,
  TraceProbe,
};

declare const probeHandleBrand: unique symbol;

/** Names a ping or traceroute that `ping` or `traceroute` started, so `cancel` can stop it. */
export type ProbeHandle = number & { readonly [probeHandleBrand]: true };

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

/** A router's routing protocols as they run, each undefined while it is not configured. */
export type RoutingProtocols = { readonly rip: RipStatus | undefined };

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
   * of what it heard. A count of Infinity pings until cancelled. Throws a RangeError for a count
   * that is not a whole number >= 1 or Infinity, or a timeout that is not > 0.
   */
  ping(
    device: DeviceId,
    target: Ipv4Address,
    options: PingOptions,
    listener: PingListener,
  ): Result<ProbeHandle, DeviceUnavailable>;
  /**
   * Traces the route to `target` from a router or host: `probesPerHop` echo requests with TTL 1,
   * then 2, and on up to `maxHops`, each waiting up to `timeoutMs`. Each probe's fate, then `done`,
   * goes to `listener` as the simulation runs, heard once as with `ping`. Throws a RangeError for
   * a hop or probe count that is not a whole number >= 1, or a timeout that is not > 0.
   */
  traceroute(
    device: DeviceId,
    target: Ipv4Address,
    options: TraceOptions,
    listener: TraceListener,
  ): Result<ProbeHandle, DeviceUnavailable>;
  /**
   * Stops a ping or traceroute now: no more requests go out, and its listener hears the summary
   * so far, or `done`. One that has ended already is left alone.
   */
  cancel(handle: ProbeHandle): void;
  /**
   * Forgets one learned address on a router or host, or all of them, as `arp -d` does, so the
   * next packet to that neighbour asks ARP again. Returns how many entries went.
   */
  clearArp(device: DeviceId, address?: Ipv4Address): Result<number, DeviceUnavailable>;
  /** A router or host's own Ethernet addresses and the ones it has learned, by address. */
  arpTable(device: DeviceId): Result<ArpTableEntry[], DeviceUnavailable>;
  /** The routes a router or host uses now, by network, for `show ip route`. */
  routes(device: DeviceId): Result<Route[], DeviceUnavailable>;
  /** A router's routing protocols as they run now, for `show ip protocols` and friends. */
  routingProtocols(device: DeviceId): Result<RoutingProtocols, DeviceUnavailable>;
  /** The addresses a switch has learned and not yet aged out, by VLAN then MAC. */
  macTable(device: DeviceId): Result<MacTableEntry[], DeviceUnavailable>;
  /** A switch's spanning tree instances, by VLAN, for `show spanning-tree`. */
  spanningTree(device: DeviceId): Result<SpanningTreeVlan[], DeviceUnavailable>;
  /** Whether each of a device's ports has its link up now, for interface status in `show`. */
  portStates(device: DeviceId): Result<Record<PortId, boolean>, DeviceUnavailable>;
  /**
   * A PC or server's IPv4 settings as the simulation runs them: from its config, or from DHCP,
   * which the config never stores. `unsupported` for a router or a switch.
   */
  hostIp(device: DeviceId): Result<HostAddressing, DeviceUnavailable>;
  /** The DHCP leases a router has granted and not yet lost, by address. */
  dhcpBindings(device: DeviceId): Result<DhcpBindingEntry[], DeviceUnavailable>;
  /**
   * `ipconfig /renew` on a DHCP host: it asks its server to extend its lease, or asks for one.
   * `listener` hears the lease, or that none came, once, as a ping's listener hears its events.
   */
  dhcpRenew(device: DeviceId, listener: DhcpListener): Result<void, DeviceUnavailable>;
  /** `ipconfig /release`: a DHCP host gives its lease back and asks for nothing until renewed. */
  dhcpRelease(device: DeviceId): Result<void, DeviceUnavailable>;
  /** Sets the one batch listener. Calling it again replaces the previous listener. */
  subscribe(listener: (batch: SimEventBatch) => void): void;
}
