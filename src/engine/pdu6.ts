import type { MacAddress } from '@/model';
import type { Ipv6Address, Ipv6Cidr } from '@/model/ipv6';

/**
 * IPv6 protocol data units, as plain data, like `pdu.ts`. Each payload's `kind` stands in for its
 * Next Header number and each ICMPv6 `type` for its type number; the tables give the numbers.
 */

export type Ipv6Packet = {
  readonly kind: 'ipv6';
  readonly src: Ipv6Address;
  readonly dst: Ipv6Address;
  /** IPv6's TTL: each router decrements it, and drops the packet when it would reach zero. */
  readonly hopLimit: number;
  readonly payload: Ipv6Payload;
};

export type Ipv6Payload = Icmpv6Message;

export const IPV6_NEXT_HEADER = { icmpv6: 58 } as const satisfies Record<
  Ipv6Payload['kind'],
  number
>;

export type Icmpv6Message =
  | Icmpv6Echo
  | Icmpv6DestinationUnreachable
  | Icmpv6TimeExceeded
  | RouterSolicitation
  | RouterAdvertisement
  | NeighborSolicitation
  | NeighborAdvertisement;

export type Icmpv6Echo = {
  readonly kind: 'icmpv6';
  readonly type: 'echo-request' | 'echo-reply';
  readonly id: number;
  readonly seq: number;
};

/**
 * ICMPv6 codes 0 and 3: a router has no route to the destination, or the destination's neighbour
 * discovery went unanswered on its link.
 */
export type Icmpv6UnreachableCode = 'no-route' | 'address-unreachable';

export type Icmpv6DestinationUnreachable = {
  readonly kind: 'icmpv6';
  readonly type: 'destination-unreachable';
  readonly code: Icmpv6UnreachableCode;
  /** The packet that could not be delivered. The wire quotes as much of it as fits. */
  readonly original: Ipv6Packet;
};

/** Code 0: a router dropped a packet whose hop limit ran out. */
export type Icmpv6TimeExceeded = {
  readonly kind: 'icmpv6';
  readonly type: 'time-exceeded';
  readonly original: Ipv6Packet;
};

/** A host asks the routers on its link to advertise now, rather than at their next interval. */
export type RouterSolicitation = {
  readonly kind: 'icmpv6';
  readonly type: 'router-solicitation';
  /** The source link-layer address option. Absent when sent from the unspecified address. */
  readonly sourceMac?: MacAddress;
};

/** One prefix information option of a router advertisement. Lifetimes are in seconds. */
export type PrefixInformation = {
  readonly prefix: Ipv6Cidr;
  /** The L flag: addresses in the prefix are on this link. */
  readonly onLink: boolean;
  /** The A flag: hosts may form an address in the prefix by SLAAC. */
  readonly autonomous: boolean;
  readonly validLifetime: number;
  readonly preferredLifetime: number;
};

/** A router says it is one, and which prefixes are on the link, so hosts can configure themselves. */
export type RouterAdvertisement = {
  readonly kind: 'icmpv6';
  readonly type: 'router-advertisement';
  /** The hop limit hosts should give their packets. */
  readonly curHopLimit: number;
  /** The M flag: get addresses from DHCPv6. Always off here. */
  readonly managed: boolean;
  /** The O flag: get other settings, such as DNS, from DHCPv6. Always off here. */
  readonly other: boolean;
  /** Seconds hosts may use the router as a default router. 0 means not a default router. */
  readonly routerLifetime: number;
  readonly sourceMac: MacAddress;
  readonly mtu: number;
  readonly prefixes: readonly PrefixInformation[];
};

/** Asks for `target`'s link-layer address, as ARP does for IPv4, at its solicited-node group. */
export type NeighborSolicitation = {
  readonly kind: 'icmpv6';
  readonly type: 'neighbor-solicitation';
  readonly target: Ipv6Address;
  /** The source link-layer address option, so the target can answer without asking back. */
  readonly sourceMac?: MacAddress;
};

/** Answers a solicitation: `target` is at `targetMac`. */
export type NeighborAdvertisement = {
  readonly kind: 'icmpv6';
  readonly type: 'neighbor-advertisement';
  readonly target: Ipv6Address;
  /** The R flag: the sender is a router. */
  readonly router: boolean;
  /** The S flag: this answers a solicitation. */
  readonly solicited: boolean;
  /** The O flag: replace a cached link-layer address. */
  readonly override: boolean;
  readonly targetMac: MacAddress;
};

export const ICMPV6_TYPE = {
  'destination-unreachable': 1,
  'time-exceeded': 3,
  'echo-request': 128,
  'echo-reply': 129,
  'router-solicitation': 133,
  'router-advertisement': 134,
  'neighbor-solicitation': 135,
  'neighbor-advertisement': 136,
} as const satisfies Record<Icmpv6Message['type'], number>;

export const ICMPV6_UNREACHABLE_CODE = {
  'no-route': 0,
  'address-unreachable': 3,
} as const satisfies Record<Icmpv6UnreachableCode, number>;

/** The ICMPv6 messages that make up Neighbor Discovery (RFC 4861). */
export type NdpMessage =
  RouterSolicitation | RouterAdvertisement | NeighborSolicitation | NeighborAdvertisement;

export const isNdp = (message: Icmpv6Message): message is NdpMessage =>
  message.type === 'router-solicitation' ||
  message.type === 'router-advertisement' ||
  message.type === 'neighbor-solicitation' ||
  message.type === 'neighbor-advertisement';

/** Neighbor Discovery messages go out with hop limit 255, and a receiver drops any with less. */
export const NDP_HOP_LIMIT = 255;
