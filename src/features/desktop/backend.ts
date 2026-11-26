import type {
  ArpTableEntry,
  BrowseTarget,
  DhcpOutcome,
  DnsLookup,
  FetchEvent,
  FetchFailure,
  HostAddressing,
  HttpResponse,
  PingOptions,
  PingReply,
  TraceOptions,
  TraceProbe,
} from '@/engine/api';
import type { DeviceId, Ipv4Address } from '@/model';

export type {
  ArpTableEntry,
  BrowseTarget,
  DhcpOutcome,
  DnsLookup,
  FetchEvent,
  FetchFailure,
  HostAddressing,
  HttpResponse,
  PingOptions,
  PingReply,
  TraceOptions,
  TraceProbe,
};

/** A host's IPv4 settings as the simulation runs them, read at simulated time `now`. */
export type LiveAddressing = { readonly addressing: HostAddressing; readonly now: number };

/**
 * Everything the Command Prompt asks of the network, in the engine's own types. `engineBackend.ts`
 * binds it to the simulation worker; tests pass their own. A method that cannot answer rejects
 * with an `Error` whose message the prompt prints.
 */
export interface HostBackend {
  /**
   * Sends `count` echo requests from `device`, calling `onReply` once per request as its answer
   * arrives. Resolves after the last one. Aborting `signal` stops the ping in the simulation and
   * resolves soon after.
   */
  ping(
    device: DeviceId,
    target: Ipv4Address,
    options: PingOptions,
    onReply: (reply: PingReply) => void,
    signal: AbortSignal,
  ): Promise<void>;
  /**
   * Traces the route from `device` to `target`, calling `onProbe` once per probe as it settles.
   * Resolves when the trace is done. Aborting `signal` stops it as it does a ping.
   */
  traceroute(
    device: DeviceId,
    target: Ipv4Address,
    options: TraceOptions,
    onProbe: (probe: TraceProbe) => void,
    signal: AbortSignal,
  ): Promise<void>;
  arpTable(device: DeviceId): Promise<ArpTableEntry[]>;
  /** Forgets `address`, or every learned address. Resolves with how many entries went. */
  clearArp(device: DeviceId, address?: Ipv4Address): Promise<number>;
  /** What the host's address is now, which for a DHCP host only the simulation knows. */
  hostIp(device: DeviceId): Promise<LiveAddressing>;
  /** `ipconfig /renew`: resolves with the lease, or word that none came. */
  renewDhcp(device: DeviceId): Promise<DhcpOutcome>;
  /** `ipconfig /release`: the host gives its lease back. */
  releaseDhcp(device: DeviceId): Promise<void>;
  /** `nslookup`: asks `server`, or the host's own DNS server, for `name`. Resolves with the outcome. */
  nslookup(device: DeviceId, name: string, server: Ipv4Address | undefined): Promise<DnsLookup>;
  /**
   * A web browser's page load. `onEvent` hears each step, ending with a `response` or `failed`,
   * and the promise resolves after that last one. Aborting `signal` stops passing events on and
   * resolves at once; the simulation finishes the load unseen.
   */
  browse(
    device: DeviceId,
    target: BrowseTarget,
    onEvent: (event: FetchEvent) => void,
    signal: AbortSignal,
  ): Promise<void>;
}
