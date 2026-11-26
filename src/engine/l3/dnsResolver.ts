import type { Ipv4Address } from '@/model';
import { ms } from '../core/time';
import type { DnsMessage } from '../dns';
import { UDP_PORT } from '../pdu';
import { hostAddressingOf, timerKey, type IpContext } from './context';
import { onFetchResolved } from './httpClient';
import { onMailResolved } from './mail';
import { originate } from './output';
import { ephemeralPort, type DnsWaiter, type PendingQuery } from './transport';
import { udp } from './udp';

/** What became of one lookup, as `nslookup` reports it. */
export type DnsLookup =
  | {
      readonly kind: 'answer';
      readonly server: Ipv4Address;
      readonly name: string;
      readonly address: Ipv4Address;
    }
  /** The server answered that it knows no such name: NXDOMAIN. */
  | { readonly kind: 'not-found'; readonly server: Ipv4Address; readonly name: string }
  /** No answer in time. Also what a query the host had no route for comes to. */
  | { readonly kind: 'timeout'; readonly server: Ipv4Address }
  /** The host has no DNS server to ask, in its config or its lease. */
  | { readonly kind: 'no-server' }
  /** The device powered off, or stepping back undid the lookup. */
  | { readonly kind: 'cancelled' };

export type DnsListener = (lookup: DnsLookup) => void;

/** How long a lookup waits for its answer: 2 seconds, as `nslookup` does. */
export const DNS_TIMEOUT = ms(2000);

/** The DNS servers a host asks, from its config or its lease. None for a router or a switch. */
export function dnsServersOf(ctx: IpContext): readonly Ipv4Address[] {
  const host = hostAddressingOf(ctx);
  return host?.kind === 'static' || host?.kind === 'leased' ? host.dns : [];
}

/** Names compare in lower case, and a trailing dot names the root, which every name ends at. */
export const normalizeName = (name: string) => name.trim().toLowerCase().replace(/\.$/, '');

/**
 * Asks `server`, or else the host's first DNS server, for `name`'s address, and tells `waiter`
 * what came back. Returns the server asked, or undefined when there is none to ask.
 */
export function startLookup(
  ctx: IpContext,
  name: string,
  server: Ipv4Address | undefined,
  waiter: DnsWaiter,
): Ipv4Address | undefined {
  const to = server ?? dnsServersOf(ctx)[0];
  if (!to) return undefined;
  const query: PendingQuery = {
    id: Math.floor(ctx.random() * 0x10000),
    port: ephemeralPort(ctx),
    server: to,
    name: normalizeName(name),
    waiter,
  };
  ctx.state.transport.queries.set(query.port, query);
  ctx.setTimer(timerKey({ kind: 'dns', port: query.port }), DNS_TIMEOUT);
  const message: DnsMessage = { kind: 'dns', type: 'query', id: query.id, name: query.name };
  originate(ctx, to, udp(query.port, UDP_PORT.dns, message));
  return to;
}

/** `nslookup`: the listener hears the outcome once. */
export function lookup(
  ctx: IpContext,
  name: string,
  server: Ipv4Address | undefined,
  listener: DnsListener,
) {
  if (!startLookup(ctx, name, server, { kind: 'lookup', listener }))
    listener({ kind: 'no-server' });
}

function settle(ctx: IpContext, query: PendingQuery, outcome: DnsLookup) {
  ctx.state.transport.queries.delete(query.port);
  ctx.clearTimer(timerKey({ kind: 'dns', port: query.port }));
  if (query.waiter.kind === 'lookup') query.waiter.listener(outcome);
  else if (query.waiter.kind === 'mail') onMailResolved(ctx, query.waiter.job, outcome);
  else onFetchResolved(ctx, query.waiter.fetch, outcome);
}

/** A DNS message arrived on `port`. A response with the ID of the query sent from it answers it. */
export function onDnsResponse(ctx: IpContext, port: number, message: DnsMessage) {
  const query = ctx.state.transport.queries.get(port);
  if (!query || message.type !== 'response' || message.id !== query.id) return;
  const { server, name } = query;
  const answer = message.answers.find((candidate) => candidate.name === name);
  settle(
    ctx,
    query,
    answer
      ? { kind: 'answer', server, name, address: answer.address }
      : { kind: 'not-found', server, name },
  );
}

export function onDnsTimer(ctx: IpContext, port: number) {
  const query = ctx.state.transport.queries.get(port);
  if (query) settle(ctx, query, { kind: 'timeout', server: query.server });
}

/** The device is going away: every lookup still waiting hears that it was cancelled. */
export function stopLookups(ctx: IpContext) {
  for (const query of [...ctx.state.transport.queries.values()]) {
    settle(ctx, query, { kind: 'cancelled' });
  }
}
