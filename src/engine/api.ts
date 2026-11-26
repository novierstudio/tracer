import type {
  DeviceId,
  Ipv4Address,
  LinkId,
  PortId,
  RemoteProtocol,
  Result,
  Topology,
} from '@/model';
import type { IpAddress } from '@/model/ipv6';
import type { SimTime } from './core/time';
import type { LinkEnd, LinkStatus } from './engine';
import type { EventId, SimEvent } from './events';
import type { MacTableEntry, SpanningTreeVlan } from './l2/switching';
import type { PortRole, PortState, SpanningTreePort, StpTimes } from './l2/stp';
import type { AclHits } from './l3/acl';
import type { ArpTableEntry } from './l3/arp';
import type { DhcpListener, DhcpOutcome, Lease } from './l3/dhcpClient';
import type { DhcpBindingEntry } from './l3/dhcpServer';
import type { DnsListener, DnsLookup } from './l3/dnsResolver';
import type { BrowseTarget, FetchEvent, FetchFailure, FetchListener } from './l3/httpClient';
import type { HostAddressing } from './l3/hostAddress';
import type { NatEndpoint, NatTranslationEntry } from './l3/nat';
import type { PingEvent, PingListener, PingOptions, PingReply, PingSummary } from './l3/ping';
import type { LearnedRoute, Route } from './l3/routes';
import type { TerminalEvent, TerminalListener } from './l3/terminal';
import type { TraceEvent, TraceListener, TraceOptions, TraceProbe } from './l3/traceroute';
import type {
  Ipv6AddressEntry,
  Ipv6AddressOrigin,
  Ipv6InterfaceStatus,
  Ipv6NeighborEntry,
  Ipv6Route,
  Ipv6Status,
  NeighborState,
} from './l3v6/status';
import type { DeviceUnavailable } from './module';
import type {
  OspfDesignated,
  OspfInterfaceState,
  OspfInterfaceStatus,
  OspfNeighborState,
  OspfNeighborStatus,
  OspfNetworkType,
  OspfStatus,
} from './routing/ospf/status';
import type { RipStatus } from './routing/rip';
import type { OspfTimers, RipTimers } from './routing/timers';
import type { TopologyPatch } from './patch';
import type { HttpResponse } from './http';

export type {
  AclHits,
  ArpTableEntry,
  BrowseTarget,
  DeviceUnavailable,
  DhcpBindingEntry,
  DhcpListener,
  DhcpOutcome,
  DnsListener,
  DnsLookup,
  FetchEvent,
  FetchFailure,
  FetchListener,
  HostAddressing,
  HttpResponse,
  Ipv6AddressEntry,
  Ipv6AddressOrigin,
  Ipv6InterfaceStatus,
  Ipv6NeighborEntry,
  Ipv6Route,
  Ipv6Status,
  LearnedRoute,
  Lease,
  LinkEnd,
  LinkStatus,
  MacTableEntry,
  NatEndpoint,
  NatTranslationEntry,
  NeighborState,
  OspfDesignated,
  OspfInterfaceState,
  OspfInterfaceStatus,
  OspfNeighborState,
  OspfNeighborStatus,
  OspfNetworkType,
  OspfStatus,
  OspfTimers,
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
  TerminalEvent,
  TerminalListener,
  TraceEvent,
  TraceListener,
  TraceOptions,
  TraceProbe,
};

declare const probeHandleBrand: unique symbol;

/** Names a ping or traceroute that `ping` or `traceroute` started, so `cancel` can stop it. */
export type ProbeHandle = number & { readonly [probeHandleBrand]: true };

declare const terminalHandleBrand: unique symbol;

/** Names a Telnet or SSH session that `openTerminal` started. */
export type TerminalHandle = number & { readonly [terminalHandleBrand]: true };

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
export type RoutingProtocols = {
  readonly rip: RipStatus | undefined;
  readonly ospf: OspfStatus | undefined;
};

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
   * Pings `target`, over IPv4 or IPv6 by its family, from a router or host in simulated time: `count` echo requests about a second
   * apart, each waiting up to `timeoutMs`. Each request's fate, then a summary, goes to `listener`
   * as the simulation runs; nothing arrives while it is paused. The listener hears each fate once
   * even when stepping back replays it, and a ping that a step back un-starts ends with a summary
   * of what it heard. A count of Infinity pings until cancelled. Throws a RangeError for a count
   * that is not a whole number >= 1 or Infinity, or a timeout that is not > 0.
   */
  ping(
    device: DeviceId,
    target: IpAddress,
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
    target: IpAddress,
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
  /**
   * `nslookup`: asks `server`, or else the host's first DNS server, for `name`'s address. The
   * listener hears the outcome once, as a ping's listener hears its events.
   */
  resolve(
    device: DeviceId,
    name: string,
    server: Ipv4Address | undefined,
    listener: DnsListener,
  ): Result<void, DeviceUnavailable>;
  /**
   * A web browser's page load: resolves the target's name with DNS unless it is an address,
   * opens a TCP connection, sends a GET and waits for the response. Each step goes to `listener`
   * once, as with `ping`.
   */
  browse(
    device: DeviceId,
    target: BrowseTarget,
    listener: FetchListener,
  ): Result<void, DeviceUnavailable>;
  /**
   * Opens a Telnet or SSH connection from a router, switch or host to `target`'s port 23 or 22.
   * `listener` hears it open or fail, then close, once each, as with `ping`. The far end's CLI
   * runs outside the simulation; the connection carries the session's lines as segments.
   */
  openTerminal(
    device: DeviceId,
    target: Ipv4Address,
    protocol: RemoteProtocol,
    listener: TerminalListener,
  ): Result<TerminalHandle, DeviceUnavailable>;
  /** Sends a line typed into an open session to the far end. */
  terminalSend(handle: TerminalHandle, text: string): void;
  /**
   * The session ended at the far end, `server`, as `exit` there ends it: `server` closes the
   * connection. Without a server that can, the client closes its own end.
   */
  terminalClose(handle: TerminalHandle, server: DeviceId | undefined): void;
  /** How many packets each entry of each of a router or switch's access lists has matched. */
  aclHits(device: DeviceId): Result<AclHits, DeviceUnavailable>;
  /** A router's NAT translations in force, for `show ip nat translations`. */
  natTranslations(device: DeviceId): Result<NatTranslationEntry[], DeviceUnavailable>;
  /** `clear ip nat translation *`: a router forgets its dynamic translations. Returns how many went. */
  clearNatTranslations(device: DeviceId): Result<number, DeviceUnavailable>;
  /**
   * A router or host's IPv6 as it runs now: its interfaces and their addresses, including the
   * ones SLAAC formed, its routing table and its neighbour cache. `unsupported` for a switch.
   */
  ipv6Status(device: DeviceId): Result<Ipv6Status, DeviceUnavailable>;
  /** Sets the one batch listener. Calling it again replaces the previous listener. */
  subscribe(listener: (batch: SimEventBatch) => void): void;
}
