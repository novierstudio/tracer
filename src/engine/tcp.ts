import type { HttpMessage } from './http';

/**
 * A TCP segment, as plain data like every PDU. Tracer's TCP is simplified: a 3-way handshake,
 * data, FIN close and RST, with no options, retransmission, window scaling or congestion control.
 * Firewalls and NAT match on the ports and flags, so this shape stays stable.
 */
export type TcpSegment = {
  readonly kind: 'tcp';
  readonly srcPort: number;
  readonly dstPort: number;
  /** The first byte this segment carries, or the SYN or FIN it stands for. Wraps at 2^32. */
  readonly seq: number;
  /** The next byte the sender expects. Meaningful only with the ACK flag. */
  readonly ack: number;
  readonly flags: TcpFlags;
  /** The bytes the sender will still take. Fixed: nothing here fills it. */
  readonly window: number;
  /** One whole application message. Tracer never splits one across segments. */
  readonly payload?: TcpPayload;
};

export type TcpFlags = {
  readonly syn: boolean;
  readonly ack: boolean;
  readonly fin: boolean;
  readonly rst: boolean;
  readonly psh: boolean;
};

export type TcpPayload = HttpMessage;

/** Well-known TCP ports. */
export const TCP_PORT = { http: 80 } as const;

/** The window every segment offers: 64 KiB less one, the most without window scaling. */
export const TCP_WINDOW = 65535;

/** Ports a client picks its own end from: the IANA dynamic range. */
export const EPHEMERAL_PORTS = { first: 49152, last: 65535 } as const;
