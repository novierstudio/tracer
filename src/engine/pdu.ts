import type { Ipv4Address, MacAddress, PrefixLength, VlanId } from '@/model';
import type { DnsMessage } from './dns';
import type { Ipv6Packet } from './pdu6';
import type { TcpSegment } from './tcp';

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

export type EthernetPayload = ArpPacket | Ipv4Packet | Ipv6Packet | Bpdu;

/** A BPDU has no EtherType: it rides in an 802.3 frame with an LLC and SNAP header instead. */
export const ETHER_TYPE = {
  arp: 0x0806,
  ipv4: 0x0800,
  ipv6: 0x86dd,
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

export type Ipv4Payload = IcmpMessage | UdpDatagram | OspfPacket | TcpSegment;

export const IP_PROTOCOL = { icmp: 1, tcp: 6, udp: 17, ospf: 89 } as const satisfies Record<
  Ipv4Payload['kind'],
  number
>;

/** The address a packet for every host on the local network goes to. Routers never forward it. */
export const LIMITED_BROADCAST = '255.255.255.255' as Ipv4Address;

/** The source of a packet from a host that has no address yet, as a DHCP client's Discover is. */
export const UNSPECIFIED_ADDRESS = '0.0.0.0' as Ipv4Address;

/**
 * The Ethernet address an IPv4 multicast group maps to: 01:00:5e, then the group's low 23 bits.
 * Only the devices that joined the group take frames sent to it.
 */
export function multicastMac(group: Ipv4Address): MacAddress {
  const [, second = 0, third = 0, fourth = 0] = group.split('.').map(Number);
  const low = [second & 0x7f, third, fourth];
  return ['01', '00', '5e', ...low.map((byte) => byte.toString(16).padStart(2, '0'))].join(
    ':',
  ) as MacAddress;
}

/** Whether an address is an IPv4 multicast group, 224.0.0.0 to 239.255.255.255. */
export const isMulticast = (address: Ipv4Address) => {
  const first = Number(address.split('.')[0]);
  return first >= 224 && first <= 239;
};

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

export type UdpPayload = DhcpMessage | RipMessage | DnsMessage;

/** Well-known ports. RIP sends from and to 520. */
export const UDP_PORT = { dns: 53, dhcpServer: 67, dhcpClient: 68, rip: 520 } as const;

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
  | (DhcpHeader & { readonly type: 'offer' } & DhcpGrant)
  | (DhcpHeader & {
      readonly type: 'request';
      readonly requestedIp?: Ipv4Address;
      readonly serverId?: Ipv4Address;
    })
  | (DhcpHeader & { readonly type: 'ack' } & DhcpGrant)
  | (DhcpHeader & { readonly type: 'nak'; readonly serverId: Ipv4Address })
  | (DhcpHeader & { readonly type: 'release'; readonly serverId: Ipv4Address });

/** The group RIPv2 routers send updates to. RIPv1 broadcasts them instead. */
export const RIP_GROUP = '224.0.0.9' as Ipv4Address;

/** A metric of 16 hops means unreachable: RIP counts no further. */
export const RIP_INFINITY = 16;

/** The most routes one RIP message carries. A bigger table goes out in several. */
export const RIP_MAX_ENTRIES = 25;

export type RipVersion = 1 | 2;

/**
 * A RIP message. A request asks a neighbour for its whole table. A response carries routes: the
 * answer to a request, a periodic update, or a triggered update after a change.
 */
export type RipMessage =
  | { readonly kind: 'rip'; readonly command: 'request'; readonly version: RipVersion }
  | {
      readonly kind: 'rip';
      readonly command: 'response';
      readonly version: RipVersion;
      readonly entries: readonly RipEntry[];
    };

/** One route in a response. */
export type RipEntry = {
  readonly network: Ipv4Address;
  /** RIPv2 carries the mask. RIPv1 has no room for one, so it is absent and the receiver infers it. */
  readonly prefixLength?: PrefixLength;
  /** Hops from the sender to the network, 1 to 15, or RIP_INFINITY for unreachable. */
  readonly metric: number;
};

export type IcmpMessage = IcmpEcho | IcmpDestinationUnreachable | IcmpTimeExceeded;

export type IcmpEcho = {
  readonly kind: 'icmp';
  readonly type: 'echo-request' | 'echo-reply';
  readonly id: number;
  readonly seq: number;
};

/**
 * ICMP codes 0, 1 and 13. Protocol and port unreachable arrive with the transport layer. A router
 * sends administratively prohibited for a packet an access list denies.
 */
export type UnreachableCode = 'network' | 'host' | 'admin-prohibited';

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
  'admin-prohibited': 13,
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
export type HdlcFrame = { readonly kind: 'hdlc'; readonly payload: Ipv4Packet | Ipv6Packet };

/** Every OSPF router on a link listens to this group: hellos go here. */
export const ALL_SPF_ROUTERS = '224.0.0.5' as Ipv4Address;

/** Only the DR and BDR of a multi-access network listen to this group. */
export const ALL_D_ROUTERS = '224.0.0.6' as Ipv4Address;

/** OSPF version 2, for IPv4. */
export const OSPF_VERSION = 2;

/** An LSA older than this, in seconds, is flushed from every database. */
export const MAX_AGE = 3600;

/** The first sequence number an LSA carries, 0x80000001 as a signed 32-bit number. Higher is newer. */
export const INITIAL_SEQUENCE = -0x7fffffff;

/** The LSAs a single area needs: each router's own links, and each multi-access network's routers. */
export type LsaType = 'router' | 'network';

export const LSA_TYPE = { router: 1, network: 2 } as const satisfies Record<LsaType, number>;

/**
 * Which LSA: its type, its link state ID (the router ID for a router LSA, the DR's interface
 * address for a network LSA) and the router that originated it.
 */
export type LsaKey = {
  readonly type: LsaType;
  readonly id: Ipv4Address;
  readonly advertisingRouter: Ipv4Address;
};

/** Which instance of an LSA: the newer has the higher sequence number. */
export type LsaHeader = LsaKey & {
  /** Seconds since it was originated, up to MAX_AGE. */
  readonly age: number;
  readonly sequence: number;
};

/** One of a router's links, as its router LSA describes it, with what sending over it costs. */
export type RouterLink =
  /** To a neighbour across a point-to-point link: its router ID, and this router's address there. */
  | {
      readonly type: 'point-to-point';
      readonly neighbor: Ipv4Address;
      readonly address: Ipv4Address;
      readonly metric: number;
    }
  /** To a multi-access network with a DR: the DR's address there, and this router's own. */
  | {
      readonly type: 'transit';
      readonly dr: Ipv4Address;
      readonly address: Ipv4Address;
      readonly metric: number;
    }
  /** To a network no neighbour is on, or a point-to-point link's subnet: its number and mask. */
  | {
      readonly type: 'stub';
      readonly network: Ipv4Address;
      readonly prefixLength: PrefixLength;
      readonly metric: number;
    };

/** A router's links in its area. Every router originates one. */
export type RouterLsa = LsaHeader & {
  readonly type: 'router';
  readonly links: readonly RouterLink[];
};

/** A multi-access network and the routers on it, originated by its DR. */
export type NetworkLsa = LsaHeader & {
  readonly type: 'network';
  readonly prefixLength: PrefixLength;
  /** The router IDs of the DR and every router fully adjacent to it. */
  readonly attached: readonly Ipv4Address[];
};

export type Lsa = RouterLsa | NetworkLsa;

/** What every OSPF packet's header says: who sent it, and in which area. */
type OspfHeader = {
  readonly kind: 'ospf';
  readonly routerId: Ipv4Address;
  readonly area: number;
};

/** Finds neighbours and keeps them: no hello within the dead interval, and the neighbour is down. */
export type OspfHello = OspfHeader & {
  readonly type: 'hello';
  /** The sending interface's mask. Neighbours on a multi-access network must agree on it. */
  readonly networkMask: PrefixLength;
  /** Seconds. Neighbours must agree on both intervals. */
  readonly helloInterval: number;
  readonly deadInterval: number;
  readonly priority: number;
  /** The DR and BDR the sender knows of, by interface address, or 0.0.0.0 for none. */
  readonly dr: Ipv4Address;
  readonly bdr: Ipv4Address;
  /** The router ID of every neighbour the sender heard on this link within the dead interval. */
  readonly neighbors: readonly Ipv4Address[];
};

/** Lists the sender's LSAs by header, so the neighbour can ask for the ones it lacks. */
export type OspfDatabaseDescription = OspfHeader & {
  readonly type: 'dbd';
  readonly mtu: number;
  /** The first DBD of an exchange. */
  readonly init: boolean;
  /** More DBDs follow. */
  readonly more: boolean;
  /** The sender leads the exchange: the router with the higher router ID does. */
  readonly master: boolean;
  readonly sequence: number;
  readonly headers: readonly LsaHeader[];
};

/** Asks a neighbour for whole LSAs. */
export type OspfLinkStateRequest = OspfHeader & {
  readonly type: 'lsr';
  readonly requests: readonly LsaKey[];
};

/** Carries whole LSAs: an answer to a request, or flooding news on. */
export type OspfLinkStateUpdate = OspfHeader & {
  readonly type: 'lsu';
  readonly lsas: readonly Lsa[];
};

/** Confirms LSAs arrived, so the sender stops retransmitting them. */
export type OspfLinkStateAck = OspfHeader & {
  readonly type: 'lsack';
  readonly headers: readonly LsaHeader[];
};

export type OspfPacket =
  | OspfHello
  | OspfDatabaseDescription
  | OspfLinkStateRequest
  | OspfLinkStateUpdate
  | OspfLinkStateAck;

export const OSPF_PACKET_TYPE = {
  hello: 1,
  dbd: 2,
  lsr: 3,
  lsu: 4,
  lsack: 5,
} as const satisfies Record<OspfPacket['type'], number>;
