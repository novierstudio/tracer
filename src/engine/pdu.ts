import type { Ipv4Address, Ipv4Cidr, MacAddress, PrefixLength, VlanId } from '@/model';
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

export type EthernetPayload =
  ArpPacket | Ipv4Packet | Ipv6Packet | Bpdu | CdpPacket | LldpPacket | LacpPdu | PagpPdu | VtpPdu;

/** The payloads that ride in an 802.3 frame with an LLC and SNAP header instead of an EtherType. */
export type SnapPayload = Bpdu | CdpPacket | PagpPdu | VtpPdu;

export const ETHER_TYPE = {
  arp: 0x0806,
  ipv4: 0x0800,
  ipv6: 0x86dd,
  lldp: 0x88cc,
  /** Slow Protocols, which LACP is subtype 1 of. */
  lacp: 0x8809,
} as const satisfies Record<Exclude<EthernetPayload['kind'], SnapPayload['kind']>, number>;

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

export type Ipv4Payload = IcmpMessage | UdpDatagram | OspfPacket | EigrpPacket | TcpSegment;

export const IP_PROTOCOL = {
  icmp: 1,
  tcp: 6,
  udp: 17,
  eigrp: 88,
  ospf: 89,
} as const satisfies Record<Ipv4Payload['kind'], number>;

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

export type UdpPayload = DhcpMessage | RipMessage | DnsMessage | HsrpMessage;

/** Well-known ports. RIP sends from and to 520. */
export const UDP_PORT = { dns: 53, dhcpServer: 67, dhcpClient: 68, rip: 520, hsrp: 1985 } as const;

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

/** Cisco's multicast for CDP and PAgP, which a switch takes for itself and never forwards. */
export const CDP_MAC = '01:00:0c:cc:cc:cc' as MacAddress;

/** The Slow Protocols multicast LACP goes to. Bridges never forward it. */
export const SLOW_PROTOCOLS_MAC = '01:80:c2:00:00:02' as MacAddress;

/** The nearest-bridge multicast LLDP goes to. Bridges never forward it. */
export const LLDP_MAC = '01:80:c2:00:00:0e' as MacAddress;

/** What a CDP or LLDP neighbour says it is. */
export type DeviceCapability = 'router' | 'switch' | 'igmp' | 'host';

/**
 * A CDPv2 advertisement: who the sender is, and from which port. A neighbour keeps it for
 * `holdtime` seconds, so the sender repeats it more often than that.
 */
export type CdpPacket = {
  readonly kind: 'cdp';
  readonly version: 2;
  readonly holdtime: number;
  readonly deviceId: string;
  /** The sending interface's address, else the device's first, as IOS picks it. */
  readonly addresses: readonly Ipv4Address[];
  /** The sending port's full name, such as `FastEthernet0/1`. */
  readonly portId: string;
  readonly capabilities: readonly DeviceCapability[];
  readonly platform: string;
  readonly software: string;
  /** A switchport's access or native VLAN. */
  readonly nativeVlan?: VlanId;
  readonly duplex: 'full' | 'half';
};

/** An LLDP advertisement. A neighbour keeps it for `ttl` seconds. */
export type LldpPacket = {
  readonly kind: 'lldp';
  readonly chassisId: MacAddress;
  /** The sending port's full name. */
  readonly portId: string;
  readonly ttl: number;
  readonly systemName: string;
  readonly systemDescription: string;
  /** What the sender can do, and what it has enabled: IOS enables what it can. */
  readonly capabilities: readonly DeviceCapability[];
  readonly managementAddress?: Ipv4Address;
  /** The sending port's VLAN ID (802.1 TLV): a switchport's access or native VLAN, else 1. */
  readonly vlan?: VlanId;
};

/** One end of an LACP conversation: the system and port, and the key its channel group gives. */
export type LacpActor = {
  readonly system: MacAddress;
  /** IOS's admin key: the channel group number. */
  readonly key: number;
  readonly port: number;
  /** Active ports start the conversation; passive ones only answer. */
  readonly active: boolean;
};

/** An LACPDU: the sender, and the partner it has heard on this link, if any. */
export type LacpPdu = {
  readonly kind: 'lacp';
  readonly actor: LacpActor;
  readonly partner?: Omit<LacpActor, 'active'>;
};

/** A PAgP packet: the sender's device and port, its group, and the partner it has heard. */
export type PagpPdu = {
  readonly kind: 'pagp';
  readonly device: MacAddress;
  readonly port: number;
  readonly group: number;
  /** Desirable ports start the conversation; auto ones only answer. */
  readonly desirable: boolean;
  readonly partner?: { readonly device: MacAddress; readonly port: number };
};

/** A VLAN as a VTP subset advertisement lists it. */
export type VtpVlanInfo = { readonly id: VlanId; readonly name: string };

/**
 * A VTP message. It goes to CDP_MAC with SNAP PID 0x2003, out of trunk ports only, and every
 * switch reads it itself: a server or client takes a newer revision and sends it on, and a
 * transparent switch passes it through unread.
 */
export type VtpPdu =
  /** Says the sender's domain and revision, and how many subset advertisements follow. */
  | {
      readonly kind: 'vtp';
      readonly code: 'summary';
      readonly version: 1 | 2;
      readonly domain: string;
      readonly revision: number;
      readonly followers: number;
      /** The address of the switch that made the change. */
      readonly updater: Ipv4Address;
      /** When it made it, as `yymmddhhmmss`. */
      readonly timestamp: string;
      /** The MD5 digest of the password and the VLANs, 16 bytes in hex. */
      readonly digest: string;
    }
  /** The VLANs themselves, at the revision the summary before it gave. */
  | {
      readonly kind: 'vtp';
      readonly code: 'subset';
      readonly version: 1 | 2;
      readonly domain: string;
      readonly revision: number;
      readonly sequence: number;
      readonly vlans: readonly VtpVlanInfo[];
    }
  /** Asks a neighbour for its VLANs, from VLAN `start` on. */
  | {
      readonly kind: 'vtp';
      readonly code: 'request';
      readonly version: 1 | 2;
      readonly domain: string;
      readonly start: number;
    };

export type HsrpOpcode = 'hello' | 'coup' | 'resign';

/** An HSRP router's state, as hellos carry it. */
export type HsrpState = 'init' | 'learn' | 'listen' | 'speak' | 'standby' | 'active';

/**
 * An HSRP message, in UDP 1985 to 224.0.0.2 (version 1) or 224.0.0.102 (version 2). The active
 * router sends from the group's virtual MAC, the others from their own.
 */
export type HsrpMessage = {
  readonly kind: 'hsrp';
  readonly version: 1 | 2;
  readonly opcode: HsrpOpcode;
  readonly state: HsrpState;
  readonly group: number;
  readonly priority: number;
  /** Seconds. */
  readonly helloTime: number;
  readonly holdTime: number;
  readonly virtualIp: Ipv4Address;
  /** The plain-text password, `cisco` by default. */
  readonly authentication: string;
  /** Version 2 only: the sender's own MAC address. */
  readonly identifier?: MacAddress;
};

/** A frame on a serial link. Cisco HDLC needs no addresses: the link has one peer. */
export type HdlcFrame = {
  readonly kind: 'hdlc';
  readonly payload: Ipv4Packet | Ipv6Packet | CdpPacket;
};

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

/** Every EIGRP router on a link listens to this group: hellos and multicast updates go here. */
export const EIGRP_GROUP = '224.0.0.10' as Ipv4Address;

/** The EIGRP header's version field. */
export const EIGRP_VERSION = 2;

/** The delay EIGRP advertises for a route that is gone: all ones, an infinite metric. */
export const EIGRP_UNREACHABLE = 0xffffffff;

/**
 * A path's metric as EIGRP carries it, unscaled. The receiver adds its own interface: the lower
 * bandwidth, the delays summed, one more hop. The composite metric comes from these fields.
 */
export type EigrpMetric = {
  /** The slowest link on the path, in kbit/s. */
  readonly bandwidth: number;
  /** The path's total delay, in tens of microseconds. EIGRP_UNREACHABLE for a route that is gone. */
  readonly delay: number;
  /** Routers on the path. EIGRP drops a route 100 hops away. */
  readonly hops: number;
  /** 255 is a perfect link. */
  readonly reliability: number;
  /** 1 is an idle link, 255 a full one. */
  readonly load: number;
  /** The smallest MTU on the path, in bytes. */
  readonly mtu: number;
};

/** Where a route redistributed into EIGRP came from. */
export type EigrpExternal = {
  /** The router ID of the router that redistributed it. */
  readonly originRouter: Ipv4Address;
  readonly originAs: number;
  readonly protocol: 'static';
  readonly externalMetric: number;
};

/** One destination in an update, query or reply. */
export type EigrpRoute = {
  readonly prefix: Ipv4Cidr;
  readonly metric: EigrpMetric;
  /** Present on an external route: one redistributed into EIGRP. */
  readonly external?: EigrpExternal;
};

/** The K-values that weigh bandwidth, load, delay and reliability. Neighbours must agree on them. */
export type EigrpKValues = readonly [k1: number, k2: number, k3: number, k4: number, k5: number];

/** What every EIGRP packet's header says. */
type EigrpHeader = {
  readonly kind: 'eigrp';
  /** The autonomous system number. Only routers in the same AS become neighbours. */
  readonly asn: number;
  /** 0 on an unreliable packet: a hello or an ack. */
  readonly sequence: number;
  /** The sequence number of the reliable packet from the receiver this acknowledges, or 0. */
  readonly ack: number;
};

/**
 * Finds and keeps neighbours. A hello with no parameters is an ack: it carries only the sequence
 * number it acknowledges, unicast to the neighbour that sent the reliable packet.
 */
export type EigrpHello = EigrpHeader & {
  readonly opcode: 'hello';
  /** Absent on an ack. */
  readonly parameters?: {
    readonly kValues: EigrpKValues;
    /** Seconds the receiver waits for the next hello before it drops the sender. */
    readonly holdTime: number;
  };
};

/**
 * Carries routes, reliably: the receiver acks each one. An update tells news, a query asks every
 * neighbour for a way to a destination the sender lost, and a reply answers a query.
 */
export type EigrpRouting = EigrpHeader & {
  readonly opcode: 'update' | 'query' | 'reply';
  /** The INIT flag, on the first update to a new neighbour, which asks for its whole table. */
  readonly init: boolean;
  readonly routes: readonly EigrpRoute[];
};

export type EigrpPacket = EigrpHello | EigrpRouting;

export const EIGRP_OPCODE = {
  update: 1,
  query: 3,
  reply: 4,
  hello: 5,
} as const satisfies Record<EigrpPacket['opcode'], number>;
