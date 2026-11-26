import type { Ipv4Address } from '@/model';
import type { HttpResponse } from '../http';
import type { TcpPayload } from '../tcp';
import type { IpContext } from './context';
import { startLookup, type DnsLookup } from './dnsResolver';
import { tcpClose, tcpConnect, tcpSend, type TcpAbort } from './tcpStack';
import type { Fetch, TcpConnection } from './transport';

/** Where a browser goes, from a URL it has parsed: `http://host:port/path`. */
export type BrowseTarget = {
  /** A name to resolve with DNS, or an IPv4 address in dotted form. */
  readonly host: string;
  readonly port: number;
  readonly path: string;
};

/**
 * A page load, step by step: at most one `resolving` (only for a name), then `connecting`, then
 * one `response` or `failed`, after which nothing more comes.
 */
export type FetchEvent =
  | { readonly kind: 'resolving'; readonly name: string; readonly server: Ipv4Address }
  | { readonly kind: 'connecting'; readonly address: Ipv4Address; readonly port: number }
  | { readonly kind: 'response'; readonly address: Ipv4Address; readonly response: HttpResponse }
  | { readonly kind: 'failed'; readonly failure: FetchFailure };

export type FetchFailure =
  | { readonly kind: 'no-dns-server' }
  | { readonly kind: 'name-not-found'; readonly name: string; readonly server: Ipv4Address }
  | { readonly kind: 'dns-timeout'; readonly server: Ipv4Address }
  /** The host answered with a reset: nothing listens on that port. */
  | { readonly kind: 'refused'; readonly address: Ipv4Address; readonly port: number }
  /** No answer in time, or the host had no route to the server. */
  | { readonly kind: 'timeout'; readonly address: Ipv4Address }
  /** The server reset the connection after it opened. */
  | { readonly kind: 'reset'; readonly address: Ipv4Address }
  /** The device powered off, or stepping back undid the load. */
  | { readonly kind: 'cancelled' };

export type FetchListener = (event: FetchEvent) => void;

const DOTTED = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** The host as an address, when it is one rather than a name to resolve. */
export function asAddress(host: string): Ipv4Address | undefined {
  const octets = DOTTED.exec(host)?.slice(1).map(Number);
  return octets?.every((octet) => octet <= 255) ? (octets.join('.') as Ipv4Address) : undefined;
}

function finish(ctx: IpContext, fetch: Fetch, event: FetchEvent) {
  ctx.state.transport.fetches.delete(fetch.id);
  fetch.listener(event);
}

const fail = (ctx: IpContext, fetch: Fetch, failure: FetchFailure) =>
  finish(ctx, fetch, { kind: 'failed', failure });

function connect(ctx: IpContext, fetch: Fetch, address: Ipv4Address) {
  fetch.listener({ kind: 'connecting', address, port: fetch.target.port });
  tcpConnect(ctx, address, fetch.target.port, { kind: 'fetch', fetch: fetch.id });
}

/** Starts a page load from this device. Its steps go to `listener` as time passes. */
export function startFetch(ctx: IpContext, target: BrowseTarget, listener: FetchListener) {
  const { transport } = ctx.state;
  const fetch: Fetch = { id: transport.nextId++, target, listener };
  transport.fetches.set(fetch.id, fetch);
  const address = asAddress(target.host);
  if (address) {
    connect(ctx, fetch, address);
    return;
  }
  const server = startLookup(ctx, target.host, undefined, { kind: 'fetch', fetch: fetch.id });
  if (!server) fail(ctx, fetch, { kind: 'no-dns-server' });
  else listener({ kind: 'resolving', name: target.host, server });
}

/** The lookup a page load waited on came back. */
export function onFetchResolved(ctx: IpContext, id: number, lookup: DnsLookup) {
  const fetch = ctx.state.transport.fetches.get(id);
  if (!fetch) return;
  switch (lookup.kind) {
    case 'answer':
      connect(ctx, fetch, lookup.address);
      return;
    case 'not-found':
      fail(ctx, fetch, { kind: 'name-not-found', name: lookup.name, server: lookup.server });
      return;
    case 'timeout':
      fail(ctx, fetch, { kind: 'dns-timeout', server: lookup.server });
      return;
    case 'no-server':
      fail(ctx, fetch, { kind: 'no-dns-server' });
      return;
    case 'cancelled':
      fail(ctx, fetch, { kind: 'cancelled' });
      return;
  }
}

/** The connection opened: send the GET. A load that was cancelled meanwhile just closes it. */
export function onFetchConnected(ctx: IpContext, id: number, connection: TcpConnection) {
  const fetch = ctx.state.transport.fetches.get(id);
  if (!fetch) {
    tcpClose(ctx, connection);
    return;
  }
  const { host, path } = fetch.target;
  tcpSend(ctx, connection, { kind: 'http', type: 'request', method: 'GET', path, host });
}

/** The response arrived whole. The connection closes on its own when the server closes. */
export function onFetchData(
  ctx: IpContext,
  id: number,
  connection: TcpConnection,
  message: TcpPayload,
) {
  const fetch = ctx.state.transport.fetches.get(id);
  if (fetch && message.kind === 'http' && message.type === 'response') {
    finish(ctx, fetch, { kind: 'response', address: connection.remote, response: message });
  }
}

export function onFetchAborted(
  ctx: IpContext,
  id: number,
  connection: TcpConnection,
  why: TcpAbort,
) {
  const fetch = ctx.state.transport.fetches.get(id);
  if (!fetch) return;
  const address = connection.remote;
  fail(
    ctx,
    fetch,
    why === 'refused'
      ? { kind: why, address, port: connection.remotePort }
      : { kind: why, address },
  );
}

/** The device is going away: every page load still running hears that it was cancelled. */
export function stopFetches(ctx: IpContext) {
  for (const fetch of [...ctx.state.transport.fetches.values()]) {
    fail(ctx, fetch, { kind: 'cancelled' });
  }
}
