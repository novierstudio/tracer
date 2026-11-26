import type {
  ArpTableEntry,
  BrowseTarget,
  DhcpOutcome,
  DnsLookup,
  FetchEvent,
  FetchFailure,
  FtpEvent,
  FtpReply,
  FtpRequest,
  FtpResult,
  HostAddressing,
  HttpResponse,
  Ipv6Status,
  Mail,
  MailFailure,
  MailOutcome,
  MailRequest,
  PingOptions,
  PingReply,
  TraceOptions,
  TraceProbe,
} from '@/engine/api';
import type { DeviceId, Ipv4Address } from '@/model';
import type { IpAddress } from '@/model/ipv6';

export type {
  ArpTableEntry,
  BrowseTarget,
  DhcpOutcome,
  DnsLookup,
  FetchEvent,
  FetchFailure,
  FtpReply,
  FtpRequest,
  FtpResult,
  HostAddressing,
  HttpResponse,
  Ipv6Status,
  Mail,
  MailFailure,
  MailOutcome,
  MailRequest,
  PingOptions,
  PingReply,
  TraceOptions,
  TraceProbe,
};

/** A host's IPv4 settings as the simulation runs them, read at simulated time `now`. */
export type LiveAddressing = { readonly addressing: HostAddressing; readonly now: number };

/** Why an FTP session did not open: the server never answered, refused, or reset the connection. */
export type FtpFailure = Extract<FtpEvent, { kind: 'failed' }>['why'];

/** A request's result, and the simulated milliseconds from sending it to its last reply. */
export type FtpOutcome = { readonly result: FtpResult; readonly elapsedMs: number };

/** An FTP session that `HostBackend.ftp` opened. */
export interface FtpSession {
  /** The server's `220` greeting. */
  readonly greeting: FtpReply;
  /**
   * Sends a request once the ones before it have ended, and resolves with its outcome. Resolves
   * with undefined when the session ends first.
   */
  send(request: FtpRequest): Promise<FtpOutcome | undefined>;
  /** Resolves when the session ends, from either side. */
  readonly closed: Promise<void>;
  /** Ends the session from this side. */
  close(): void;
}

export type FtpOpening =
  | { readonly kind: 'open'; readonly session: FtpSession }
  | { readonly kind: 'failed'; readonly why: FtpFailure };

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
    target: IpAddress,
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
    target: IpAddress,
    options: TraceOptions,
    onProbe: (probe: TraceProbe) => void,
    signal: AbortSignal,
  ): Promise<void>;
  arpTable(device: DeviceId): Promise<ArpTableEntry[]>;
  /** Forgets `address`, or every learned address. Resolves with how many entries went. */
  clearArp(device: DeviceId, address?: Ipv4Address): Promise<number>;
  /** What the host's address is now, which for a DHCP host only the simulation knows. */
  hostIp(device: DeviceId): Promise<LiveAddressing>;
  /** The host's IPv6 as it runs now: its link-local address, SLAAC addresses and gateway. */
  ipv6Status(device: DeviceId): Promise<Ipv6Status>;
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
  /** `ftp <ip>`: opens a session to the server's port 21. Resolves once it opens or fails. */
  ftp(device: DeviceId, server: Ipv4Address): Promise<FtpOpening>;
  /** The Email app's Send or Receive. Resolves with how it ended. */
  mail(device: DeviceId, request: MailRequest): Promise<MailOutcome>;
}
