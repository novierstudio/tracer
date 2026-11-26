import type { Ipv4Address, RemoteProtocol } from '@/model';
import { EPHEMERAL_PORTS } from '../tcp';
import type { IpContext } from './context';
import type { DnsListener } from './dnsResolver';
import type { BrowseTarget, FetchListener } from './httpClient';
import type { TerminalListener } from './terminal';

/**
 * Where a TCP connection is. A closed connection is not kept, and Tracer skips TIME-WAIT: the
 * side that acknowledges the last FIN forgets the connection at once.
 */
export type TcpConnectionState =
  | 'syn-sent'
  | 'syn-received'
  | 'established'
  | 'fin-wait-1'
  | 'fin-wait-2'
  | 'close-wait'
  | 'closing'
  | 'last-ack';

/**
 * What reads a connection's data and hears how it ends: the HTTP server, a page load, a vty line
 * a Telnet or SSH client reached, or that client's end.
 */
export type TcpOwner =
  | { readonly kind: 'http-server' }
  | { readonly kind: 'fetch'; readonly fetch: number }
  | { readonly kind: 'vty'; readonly protocol: RemoteProtocol; readonly line: number }
  | { readonly kind: 'terminal'; readonly terminal: number };

export type TcpConnection = {
  readonly id: number;
  readonly local: Ipv4Address;
  readonly localPort: number;
  readonly remote: Ipv4Address;
  readonly remotePort: number;
  readonly owner: TcpOwner;
  state: TcpConnectionState;
  /** The sequence number the next segment sent starts at. */
  sndNxt: number;
  /** The sequence number the next segment received must start at. */
  rcvNxt: number;
};

/** What waits on a DNS answer: an `nslookup`, or a page load that needs the address. */
export type DnsWaiter =
  | { readonly kind: 'lookup'; readonly listener: DnsListener }
  | { readonly kind: 'fetch'; readonly fetch: number };

/** A query sent and not yet answered, by the port it went from. */
export type PendingQuery = {
  readonly id: number;
  readonly port: number;
  readonly server: Ipv4Address;
  readonly name: string;
  readonly waiter: DnsWaiter;
};

export type Fetch = {
  readonly id: number;
  readonly target: BrowseTarget;
  readonly listener: FetchListener;
};

/** A Telnet or SSH client: the connection it opened, once it has one, and who hears about it. */
export type Terminal = {
  readonly id: number;
  readonly protocol: RemoteProtocol;
  readonly listener: TerminalListener;
  connection?: number;
  /** Set once the far end accepts. */
  opened?: true;
};

/** A device's transport layer and the applications on it: plain data, so snapshots copy it. */
export type Transport = {
  readonly connections: Map<number, TcpConnection>;
  /** By the local port each query went from. */
  readonly queries: Map<number, PendingQuery>;
  readonly fetches: Map<number, Fetch>;
  readonly terminals: Map<number, Terminal>;
  /** Numbers connections, page loads and terminals. */
  nextId: number;
};

export const emptyTransport = (): Transport => ({
  connections: new Map(),
  queries: new Map(),
  fetches: new Map(),
  terminals: new Map(),
  nextId: 1,
});

/** A 32-bit number from the run's seeded stream, as an ISN or a DNS ID takes. */
export const random32 = (ctx: IpContext) => Math.floor(ctx.random() * 0x1_0000_0000) >>> 0;

/** A free port in the dynamic range, drawn from the seeded stream. */
export function ephemeralPort(ctx: IpContext): number {
  const { connections, queries } = ctx.state.transport;
  const taken = new Set([...connections.values()].map((connection) => connection.localPort));
  for (const port of queries.keys()) taken.add(port);
  const span = EPHEMERAL_PORTS.last - EPHEMERAL_PORTS.first + 1;
  let port = EPHEMERAL_PORTS.first + Math.floor(ctx.random() * span);
  while (taken.has(port)) port = port === EPHEMERAL_PORTS.last ? EPHEMERAL_PORTS.first : port + 1;
  return port;
}
