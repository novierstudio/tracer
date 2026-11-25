import type { Ipv4Address, MacAddress, VlanId } from '@/model';

/**
 * Protocol data units, as plain data. They cross to the main thread inside frame events and
 * drive the PDU inspector, so every field is structured-cloneable and nothing holds a function.
 *
 * Each payload's `kind` stands in for the number that names it on the wire (EtherType, IP
 * protocol, ICMP type), so a header and its payload cannot disagree. The tables below give the
 * numbers for display.
 */

export const BROADCAST_MAC = 'ff:ff:ff:ff:ff:ff' as MacAddress;

/** The target hardware address of an ARP request, which is what the request asks for. */
export const UNKNOWN_MAC = '00:00:00:00:00:00' as MacAddress;

/** An 802.1Q tag. Priority bits are not modelled. */
export type VlanTag = { readonly vlan: VlanId };

export type EthernetFrame = {
  readonly kind: 'ethernet';
  readonly dst: MacAddress;
  readonly src: MacAddress;
  /** Present on a frame that crosses a trunk in a VLAN other than the native one. */
  readonly tag?: VlanTag;
  readonly payload: EthernetPayload;
};

export type EthernetPayload = ArpPacket | Ipv4Packet;

export const ETHER_TYPE = {
  arp: 0x0806,
  ipv4: 0x0800,
} as const satisfies Record<EthernetPayload['kind'], number>;

export const DOT1Q_TPID = 0x8100;

export type ArpPacket = {
  readonly kind: 'arp';
  readonly op: 'request' | 'reply';
  readonly senderMac: MacAddress;
  readonly senderIp: Ipv4Address;
  readonly targetMac: MacAddress;
  readonly targetIp: Ipv4Address;
};

export type Ipv4Packet = {
  readonly kind: 'ipv4';
  readonly src: Ipv4Address;
  readonly dst: Ipv4Address;
  readonly ttl: number;
  /** The sender's identification counter. */
  readonly id: number;
  readonly payload: Ipv4Payload;
};

/** UDP and TCP join this union with the transport layer. */
export type Ipv4Payload = IcmpMessage;

export const IP_PROTOCOL = { icmp: 1 } as const satisfies Record<Ipv4Payload['kind'], number>;

export type IcmpMessage = IcmpEcho | IcmpDestinationUnreachable | IcmpTimeExceeded;

export type IcmpEcho = {
  readonly kind: 'icmp';
  readonly type: 'echo-request' | 'echo-reply';
  readonly id: number;
  readonly seq: number;
};

/** ICMP codes 0 and 1. Protocol and port unreachable arrive with the transport layer. */
export type UnreachableCode = 'network' | 'host';

export type IcmpDestinationUnreachable = {
  readonly kind: 'icmp';
  readonly type: 'destination-unreachable';
  readonly code: UnreachableCode;
  /** The packet that could not be delivered. The wire quotes its header and first 8 bytes. */
  readonly original: Ipv4Packet;
};

export type IcmpTimeExceeded = {
  readonly kind: 'icmp';
  readonly type: 'time-exceeded';
  /** The packet whose TTL ran out. The wire quotes its header and first 8 bytes. */
  readonly original: Ipv4Packet;
};

export const ICMP_TYPE = {
  'echo-reply': 0,
  'destination-unreachable': 3,
  'echo-request': 8,
  'time-exceeded': 11,
} as const satisfies Record<IcmpMessage['type'], number>;

export const UNREACHABLE_CODE = {
  network: 0,
  host: 1,
} as const satisfies Record<UnreachableCode, number>;

/** A frame on a serial link. Cisco HDLC needs no addresses: the link has one peer. */
export type HdlcFrame = { readonly kind: 'hdlc'; readonly payload: Ipv4Packet };
