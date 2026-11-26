import type { Ipv4Address } from '@/model';

/**
 * A DNS message over UDP, as plain data. Tracer asks one question per message, always for an A
 * record (a name's IPv4 address), so the counts, the type and the class stay implicit.
 */
export type DnsMessage = DnsQuery | DnsResponse;

type DnsHeader = {
  readonly kind: 'dns';
  /** The ID a client picks at random, so it can match the response to its query. */
  readonly id: number;
  /** The name asked about, in lower case. */
  readonly name: string;
};

export type DnsQuery = DnsHeader & { readonly type: 'query' };

export type DnsResponse = DnsHeader & {
  readonly type: 'response';
  /** `name-error` is NXDOMAIN: the server knows no such name. */
  readonly rcode: DnsRcode;
  readonly answers: readonly DnsAnswer[];
};

export type DnsRcode = 'no-error' | 'name-error';

export const DNS_RCODE = { 'no-error': 0, 'name-error': 3 } as const satisfies Record<
  DnsRcode,
  number
>;

export type DnsAnswer = {
  readonly name: string;
  readonly address: Ipv4Address;
  /** Seconds a resolver may keep the answer. */
  readonly ttl: number;
};

/** The TTL a Tracer DNS server gives its answers: a day. */
export const DNS_TTL = 86400;
