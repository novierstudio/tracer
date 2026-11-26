import type { Ipv4Address, MacAddress, PrefixLength, VlanId } from '@/model';

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

export type EthernetPayload = ArpPacket | Ipv4Packet | Bpdu;

/** A BPDU has no EtherType: it rides in an 802.3 frame with an LLC and SNAP header instead. */
export const ETHER_TYPE = {
  arp: 0x0806,
  ipv4: 0x0800,
} as const satisfies Record<Exclude<EthernetPayload['kind'], 'bpdu'>, number>;

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

/** TCP joins this union when it arrives. */
export type Ipv4Payload = IcmpMessage | UdpDatagram;

export const IP_PROTOCOL = { icmp: 1, udp: 17 } as const satisfies Record<
  Ipv4Payload['kind'],
  number
>;

/** The address a packet for every host on the local network goes to. Routers never forward it. */
export const LIMITED_BROADCAST = '255.255.255.255' as Ipv4Address;

/** The source of a packet from a host that has no address yet, as a DHCP client's Discover is. */
export const UNSPECIFIED_ADDRESS = '0.0.0.0' as Ipv4Address;

/**
 * A UDP datagram. Unlike the other headers its payload's `kind` cannot stand in for a number,
 * since one protocol listens on one port and answers from another, so both ports are explicit.
 * The checksum is left to the wire encoding.
 */
export type UdpDatagram = {
  readonly kind: 'udp';
  readonly srcPort: number;
  readonly dstPort: number;
  readonly payload: UdpPayload;
};

export type UdpPayload = DhcpMessage;

/** Well-known ports. */
export const UDP_PORT = { dhcpServer: 67, dhcpClient: 68 } as const;

/** Option 53, which says what a DHCP message is for. */
export type DhcpMessageType = DhcpMessage['type'];

export const DHCP_MESSAGE_TYPE = {
  discover: 1,
  offer: 2,
  request: 3,
  ack: 5,
  nak: 6,
  release: 7,
} as const satisfies Record<DhcpMessageType, number>;

/** BOOTP's fixed fields, which every DHCP message carries. `siaddr`, `sname` and `file` stay empty. */
type DhcpHeader = {
  readonly kind: 'dhcp';
  /** The transaction ID a client picks at random, so it can match the replies to its request. */
  readonly xid: number;
  /** Relay agents this message has crossed. */
  readonly hops: number;
  /** The client asks for replies by broadcast, since it cannot take unicast before it has an address. */
  readonly broadcast: boolean;
  /** The client's own address, when it has one to renew or release. */
  readonly ciaddr: Ipv4Address;
  /** The address the server offers or grants. */
  readonly yiaddr: Ipv4Address;
  /** The relay agent that passed the request on, which tells the server the client's network. */
  readonly giaddr: Ipv4Address;
  readonly chaddr: MacAddress;
};

/** A lease length in seconds, as option 51 carries it, or the all-ones value that means forever. */
export type LeaseTime = number | 'infinite';

/** What comes with an offered or granted address. Routers and DNS servers are options 3 and 6. */
export type DhcpGrant = {
  readonly serverId: Ipv4Address;
  readonly leaseTime: LeaseTime;
  readonly subnetMask: PrefixLength;
  readonly routers: readonly Ipv4Address[];
  readonly dnsServers: readonly Ipv4Address[];
};

/**
 * A DHCP message, by its option 53 type. Each type carries only the options that matter to it:
 * a Discover may ask for an address, an Offer and an Ack carry the grant, a Request names the
 * address and, while selecting, the server it answers, and a Nak or a Release names its server.
 */
export type DhcpMessage =
  | (DhcpHeader & { readonly type: 'discover'; readonly requestedIp?: Ipv4Address })
  | (DhcpHeader & { readonly type: 'offer' | 'ack' } & DhcpGrant)
  | (DhcpHeader & {
      readonly type: 'request';
      readonly requestedIp?: Ipv4Address;
      readonly serverId?: Ipv4Address;
    })
  | (DhcpHeader & { readonly type: 'nak' | 'release'; readonly serverId: Ipv4Address });

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

/** Where Cisco PVST+ sends its BPDUs, one per VLAN, tagged on a trunk like the VLAN's frames. */
export const PVST_MAC = '01:00:0c:cc:cc:cd' as MacAddress;

/** A bridge in spanning tree: the lower priority wins, then the lower MAC address. */
export type BridgeId = {
  /** The configured priority plus the VLAN, which PVST+ carries as the extended system ID. */
  readonly priority: number;
  readonly mac: MacAddress;
};

/** A port in its bridge's BPDUs, written `128.1`: the lower priority wins, then the lower number. */
export type StpPortId = { readonly priority: number; readonly number: number };

/**
 * An 802.1D bridge protocol data unit. Times are in seconds, as `show spanning-tree` prints them;
 * the wire carries 1/256ths.
 */
export type Bpdu = ConfigBpdu | TcnBpdu;

/** What a designated bridge says about the path to the root on a segment. */
export type ConfigBpdu = {
  readonly kind: 'bpdu';
  readonly type: 'config';
  readonly root: BridgeId;
  readonly rootPathCost: number;
  readonly bridge: BridgeId;
  readonly port: StpPortId;
  /** Seconds since the root sent this, plus one for each bridge that passed it on. */
  readonly messageAge: number;
  readonly maxAge: number;
  readonly helloTime: number;
  readonly forwardDelay: number;
  /** The root says the topology changed: bridges age out learned addresses after forward delay. */
  readonly topologyChange: boolean;
  /** Acknowledges a topology change notification that arrived on this segment. */
  readonly topologyChangeAck: boolean;
};

/** A topology change notification, sent out of the root port toward the root. */
export type TcnBpdu = { readonly kind: 'bpdu'; readonly type: 'tcn' };

/** A frame on a serial link. Cisco HDLC needs no addresses: the link has one peer. */
export type HdlcFrame = { readonly kind: 'hdlc'; readonly payload: Ipv4Packet };
