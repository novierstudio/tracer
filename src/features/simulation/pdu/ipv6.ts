import {
  ICMPV6_TYPE,
  ICMPV6_UNREACHABLE_CODE,
  IPV6_NEXT_HEADER,
  isNdp,
  NDP_HOP_LIMIT,
  type Icmpv6Message,
  type Icmpv6UnreachableCode,
  type Ipv6Packet,
  type PrefixInformation,
} from '@/engine/pdu6';
import type { MacAddress } from '@/model';
import {
  ALL_NODES,
  ALL_ROUTERS,
  formatIpv6Cidr,
  inIpv6Prefix,
  ipv6MulticastMac,
  ipv6ToBigInt,
  isIpv6Multicast,
  isLinkLocal,
  UNSPECIFIED_IPV6,
  type Ipv6Address,
  type Ipv6Cidr,
} from '@/model/ipv6';
import { formatSeconds, hex, internetChecksum, macBytes, u16, u32, type Part } from './encode';

/** Dissectors for IPv6 and the ICMPv6 it carries, Neighbor Discovery included. */

/** A layer before its fields are placed on the wire. Every one of them is at OSI layer 3. */
export type Section = {
  readonly id: 'ipv6' | 'icmpv6' | 'quoted';
  readonly name: string;
  readonly summary: string;
  readonly parts: readonly Part[];
};

const HEADER_LENGTH = 40;

/** Every IPv6 link carries at least this much, so an error quotes the packet up to it. */
const MIN_MTU = 1280;
const MAX_QUOTE = MIN_MTU - HEADER_LENGTH - 8;

const INFINITE = 0xffffffff;

const SOLICITED_NODES: Ipv6Cidr = { address: 'ff02::1:ff00:0' as Ipv6Address, prefixLength: 104 };

const isSolicitedNode = (address: Ipv6Address) => inIpv6Prefix(SOLICITED_NODES, address);

function ipv6Bytes(address: Ipv6Address): number[] {
  const value = ipv6ToBigInt(address);
  return Array.from({ length: 16 }, (_, index) =>
    Number((value >> BigInt(120 - 8 * index)) & 0xffn),
  );
}

const ALL_NODES_MAC = ipv6MulticastMac(ALL_NODES);
const ALL_ROUTERS_MAC = ipv6MulticastMac(ALL_ROUTERS);

/** What a `33:33` destination MAC means: the IPv6 group it carries. */
export function describeIpv6GroupMac(mac: MacAddress): string {
  if (mac === ALL_NODES_MAC) {
    return 'The MAC of ff02::1, all nodes: every IPv6 device on the LAN takes it.';
  }
  if (mac === ALL_ROUTERS_MAC) {
    return 'The MAC of ff02::2, all routers: only IPv6 routers take it, and hosts ignore it.';
  }
  if (mac.startsWith('33:33:ff:')) {
    return 'The MAC of a solicited-node group: 33:33:ff and the last 24 bits of the address asked about. Only devices whose address ends that way take it, so the rest are not disturbed as by an ARP broadcast.';
  }
  return 'An IPv6 multicast MAC: 33:33 and the group’s last 32 bits. Only devices in the group take it.';
}

function describeAddress(address: Ipv6Address, role: 'src' | 'dst') {
  if (role === 'src') {
    if (address === UNSPECIFIED_IPV6) {
      return 'All zeros, the unspecified address: the sender has no address yet, as while it checks that the one it wants is free.';
    }
    return isLinkLocal(address)
      ? 'A link-local address, from fe80::/10. Every IPv6 interface has one, and Neighbor Discovery speaks from it. Routers never forward a packet from it to another link.'
      : 'The device that created the packet. It stays the same all the way.';
  }
  if (address === ALL_NODES) {
    return 'ff02::1, all nodes: every IPv6 device on the link takes it. Routers keep it on the link.';
  }
  if (address === ALL_ROUTERS) {
    return 'ff02::2, all routers: only the IPv6 routers on the link take it.';
  }
  if (isSolicitedNode(address)) {
    return 'A solicited-node group: ff02::1:ff and the last 24 bits of the address asked about. Only the device that may own the address listens, where ARP would broadcast to everyone.';
  }
  if (isIpv6Multicast(address)) {
    return 'A multicast group: only the devices that joined it take the packet.';
  }
  return isLinkLocal(address)
    ? 'A link-local address: the packet is for a neighbour on this link, and no router passes it on.'
    : 'Where the packet is going. Every router looks it up in its IPv6 routing table.';
}

const TYPE_NAMES: Record<Icmpv6Message['type'], string> = {
  'echo-request': 'echo request',
  'echo-reply': 'echo reply',
  'destination-unreachable': 'destination unreachable',
  'time-exceeded': 'time exceeded',
  'router-solicitation': 'router solicitation',
  'router-advertisement': 'router advertisement',
  'neighbor-solicitation': 'neighbor solicitation',
  'neighbor-advertisement': 'neighbor advertisement',
};

const TYPE_EXPLAIN: Record<Icmpv6Message['type'], string> = {
  'echo-request':
    'An echo request asks “are you there?”. The destination answers with an echo reply.',
  'echo-reply': 'An echo reply answers an echo request: the destination is reachable.',
  'destination-unreachable': 'A router or host could not deliver a packet and says why.',
  'time-exceeded': 'A router dropped a packet whose hop limit ran out, and tells its sender.',
  'router-solicitation':
    'Neighbor Discovery. A host asks the routers on its link to advertise now, rather than at their next interval.',
  'router-advertisement':
    'Neighbor Discovery. A router says it is one and which prefixes are on the link, so hosts can give themselves an address and a gateway.',
  'neighbor-solicitation':
    'Neighbor Discovery, IPv6’s ARP request: who has the target address? Its owner answers with a neighbor advertisement.',
  'neighbor-advertisement':
    'Neighbor Discovery, IPv6’s ARP reply: the target address is at the MAC this message carries.',
};

const UNREACHABLE_NAME: Record<Icmpv6UnreachableCode, string> = {
  'no-route': 'no route',
  'address-unreachable': 'address unreachable',
};

const UNREACHABLE_EXPLAIN: Record<Icmpv6UnreachableCode, string> = {
  'no-route': 'No route to destination: the router has no route to that network.',
  'address-unreachable':
    'Address unreachable: the router asked for the destination’s MAC on its link, and nobody answered.',
};

const capitalize = (text: string) => `${text[0]!.toUpperCase()}${text.slice(1)}`;

/** The ICMPv6 layer's summary, which also names what a quoted packet carried. */
function describeMessage(message: Icmpv6Message): string {
  const name = capitalize(TYPE_NAMES[message.type]);
  switch (message.type) {
    case 'echo-request':
    case 'echo-reply':
      return `${name}, seq ${message.seq}`;
    case 'destination-unreachable':
      return `${name} (${UNREACHABLE_NAME[message.code]})`;
    case 'time-exceeded':
    case 'router-solicitation':
      return name;
    case 'router-advertisement':
      return message.prefixes.length > 0
        ? `${name}, prefix ${message.prefixes.map((p) => formatIpv6Cidr(p.prefix)).join(', ')}`
        : `${name}, no prefix`;
    case 'neighbor-solicitation':
      return `${name} for ${message.target}`;
    case 'neighbor-advertisement':
      return `${name}: ${message.target} is at ${message.targetMac}`;
  }
}

const RESERVED: Omit<Part, 'id'> = {
  label: 'Reserved',
  value: '0',
  explain: 'Four bytes left zero.',
  bytes: [0, 0, 0, 0],
};

const linkLayerOption = (type: 1 | 2, mac: MacAddress) => [type, 1, ...macBytes(mac)];

function sourceMacPart(mac: MacAddress): Part {
  return {
    id: 'icmpv6.option.1',
    label: 'Source link-layer address',
    value: mac,
    explain:
      'Option 1: the sender’s MAC, so the receiver can answer at once without asking for it first.',
    bytes: linkLayerOption(1, mac),
  };
}

/** Flags in a byte, highest bit first, as `0xC0 (Router, Solicited)`. */
function flagsValue(flags: readonly (readonly [boolean, number, string, ...string[]])[]) {
  const byte = flags.reduce((acc, [on, bit]) => (on ? acc | bit : acc), 0);
  const names = flags.filter(([on]) => on).map(([, , name]) => name);
  return { byte, value: `${hex(byte, 2)} (${names.length > 0 ? names.join(', ') : 'none'})` };
}

const lifetime = (seconds: number) => (seconds === INFINITE ? 'Infinite' : formatSeconds(seconds));

function prefixParts(info: PrefixInformation, index: number): Part[] {
  const id = `icmpv6.prefix.${index}`;
  const { byte, value } = flagsValue([
    [info.onLink, 0x80, 'on-link'],
    [info.autonomous, 0x40, 'autonomous'],
  ]);
  return [
    {
      id: `${id}.length`,
      label: 'Prefix length',
      value: `/${info.prefix.prefixLength}`,
      explain:
        'Option 3, prefix information. How many leading bits name the network. SLAAC needs /64, which leaves 64 bits for the host’s own interface ID.',
      bytes: [3, 4, info.prefix.prefixLength],
    },
    {
      id: `${id}.flags`,
      label: 'Prefix flags',
      value,
      explain:
        'L, on-link: addresses in the prefix are on this link, so hosts reach them directly. A, autonomous: hosts may form an address in it themselves (SLAAC).',
      bytes: [byte],
    },
    {
      id: `${id}.valid`,
      label: 'Valid lifetime',
      value: lifetime(info.validLifetime),
      explain: 'How long an address formed from the prefix stays usable.',
      bytes: u32(info.validLifetime),
    },
    {
      id: `${id}.preferred`,
      label: 'Preferred lifetime',
      value: lifetime(info.preferredLifetime),
      explain:
        'How long such an address is chosen for new connections. After that it still works, but only for the ones already open.',
      bytes: u32(info.preferredLifetime),
    },
    { id: `${id}.reserved`, ...RESERVED },
    {
      id: `${id}.prefix`,
      label: 'Prefix',
      value: formatIpv6Cidr(info.prefix),
      explain:
        'The network on this link. A host appends its 64-bit interface ID, made from its MAC by EUI-64, to get an address.',
      bytes: ipv6Bytes(info.prefix.address),
    },
  ];
}

/** The fields after the checksum, by message type. */
function bodyParts(packet: Ipv6Packet, message: Icmpv6Message): Part[] {
  switch (message.type) {
    case 'echo-request':
    case 'echo-reply':
      return [
        {
          id: 'icmpv6.id',
          label: 'Identifier',
          value: String(message.id),
          explain:
            'Tells apart pings running at once, so each reply finds the ping that sent its request.',
          bytes: u16(message.id),
        },
        {
          id: 'icmpv6.seq',
          label: 'Sequence',
          value: String(message.seq),
          explain: 'Counts the echoes of one ping, 1, 2, 3, so a lost one shows as a gap.',
          bytes: u16(message.seq),
        },
      ];
    case 'destination-unreachable':
    case 'time-exceeded':
      return [
        {
          id: 'icmpv6.unused',
          label: 'Unused',
          value: '0',
          explain: 'Four bytes this type leaves empty.',
          bytes: [0, 0, 0, 0],
        },
      ];
    case 'router-solicitation':
      return [
        { id: 'icmpv6.reserved', ...RESERVED },
        ...(message.sourceMac ? [sourceMacPart(message.sourceMac)] : []),
      ];
    case 'neighbor-solicitation': {
      const dad = packet.src === UNSPECIFIED_IPV6;
      return [
        { id: 'icmpv6.reserved', ...RESERVED },
        {
          id: 'icmpv6.target',
          label: 'Target address',
          value: message.target,
          explain: dad
            ? 'The address the sender wants to use. An answer means it is taken already: this is duplicate address detection.'
            : 'The address whose MAC the sender needs. Only its owner answers.',
          bytes: ipv6Bytes(message.target),
        },
        ...(message.sourceMac ? [sourceMacPart(message.sourceMac)] : []),
      ];
    }
    case 'neighbor-advertisement': {
      const flags = [
        [message.router, 0x80, 'Router', 'R: the sender is a router.'],
        [message.solicited, 0x40, 'Solicited', 'S: this answers a solicitation.'],
        [message.override, 0x20, 'Override', 'O: replace any MAC already cached for the target.'],
      ] as const;
      const { byte, value } = flagsValue(flags);
      const set = flags.filter(([on]) => on).map(([, , , explain]) => explain);
      return [
        {
          id: 'icmpv6.flags',
          label: 'Flags',
          value,
          explain: `${set.length > 0 ? set.join(' ') : 'No flag is set.'} The other bits are reserved.`,
          bytes: [byte, 0, 0, 0],
        },
        {
          id: 'icmpv6.target',
          label: 'Target address',
          value: message.target,
          explain: 'The address this advertisement is about.',
          bytes: ipv6Bytes(message.target),
        },
        {
          id: 'icmpv6.option.2',
          label: 'Target link-layer address',
          value: message.targetMac,
          explain: 'Option 2, the answer: the MAC that owns the target address.',
          bytes: linkLayerOption(2, message.targetMac),
        },
      ];
    }
    case 'router-advertisement': {
      const { byte, value } = flagsValue([
        [message.managed, 0x80, 'M'],
        [message.other, 0x40, 'O'],
      ]);
      return [
        {
          id: 'icmpv6.curHopLimit',
          label: 'Hop limit for hosts',
          value: message.curHopLimit === 0 ? '0 (unspecified)' : String(message.curHopLimit),
          explain: 'The hop limit hosts on the link should give the packets they send.',
          bytes: [message.curHopLimit],
        },
        {
          id: 'icmpv6.flags',
          label: 'Flags',
          value,
          explain:
            'M says to get an address from DHCPv6, O to get other settings, such as DNS, from it. With both off, hosts configure themselves from this advertisement alone.',
          bytes: [byte],
        },
        {
          id: 'icmpv6.routerLifetime',
          label: 'Router lifetime',
          value:
            message.routerLifetime === 0
              ? '0 s (not a default router)'
              : formatSeconds(message.routerLifetime),
          explain:
            'How long hosts may use this router as their default gateway. 0 means not at all.',
          bytes: u16(message.routerLifetime),
        },
        {
          id: 'icmpv6.reachable',
          label: 'Reachable time',
          value: '0 (unspecified)',
          explain:
            'How long a neighbour counts as reachable after it last proved it. 0 leaves it to each host.',
          bytes: u32(0),
        },
        {
          id: 'icmpv6.retrans',
          label: 'Retransmit timer',
          value: '0 (unspecified)',
          explain: 'How long to wait before asking a neighbour again. 0 leaves it to each host.',
          bytes: u32(0),
        },
        sourceMacPart(message.sourceMac),
        {
          id: 'icmpv6.option.5',
          label: 'MTU',
          value: `${message.mtu} bytes`,
          explain: 'Option 5: the largest packet the link carries, so every host on it agrees.',
          bytes: [5, 1, 0, 0, ...u32(message.mtu)],
        },
        ...message.prefixes.flatMap(prefixParts),
      ];
    }
  }
}

/** What an error quotes of the packet it is about: as much as fits in the minimum MTU. */
function quotedSection(original: Ipv6Packet): Section {
  const bytes = ipv6PacketBytes(original).slice(0, MAX_QUOTE);
  const header = `${original.src} → ${original.dst}, hop limit ${original.hopLimit}`;
  const start = original.payload;
  const startText = `ICMPv6 ${TYPE_NAMES[start.type]}${'seq' in start ? `, id ${start.id}, seq ${start.seq}` : ''}`;
  return {
    id: 'quoted',
    name: 'Packet it is about',
    summary: header,
    parts: [
      {
        id: 'quoted.header',
        label: 'IPv6 header',
        value: header,
        explain:
          'The header of the packet that failed, copied back so its sender can tell which one it was.',
        bytes: bytes.slice(0, HEADER_LENGTH),
      },
      {
        id: 'quoted.payload',
        label: 'Its payload',
        value: startText,
        explain:
          'What that packet carried. ICMPv6 quotes as much of it as fits in 1280 bytes, the smallest packet every IPv6 link must carry.',
        bytes: bytes.slice(HEADER_LENGTH),
      },
    ],
  };
}

/** The pseudo-header the ICMPv6 checksum covers: the addresses, the length and next header 58. */
const pseudoHeader = (packet: Ipv6Packet, length: number) => [
  ...ipv6Bytes(packet.src),
  ...ipv6Bytes(packet.dst),
  ...u32(length),
  0,
  0,
  0,
  IPV6_NEXT_HEADER.icmpv6,
];

function icmpv6Sections(packet: Ipv6Packet): Section[] {
  const message = packet.payload;
  const type = ICMPV6_TYPE[message.type];
  const code =
    message.type === 'destination-unreachable' ? ICMPV6_UNREACHABLE_CODE[message.code] : 0;
  const body = bodyParts(packet, message);
  const quoted = 'original' in message ? quotedSection(message.original) : undefined;
  const rest = [...body, ...(quoted?.parts ?? [])].flatMap((part) => part.bytes);
  const checksum = internetChecksum([
    ...pseudoHeader(packet, 4 + rest.length),
    type,
    code,
    0,
    0,
    ...rest,
  ]);
  const parts: Part[] = [
    {
      id: 'icmpv6.type',
      label: 'Type',
      value: `${type} (${TYPE_NAMES[message.type]})`,
      explain: TYPE_EXPLAIN[message.type],
      bytes: [type],
    },
    {
      id: 'icmpv6.code',
      label: 'Code',
      value:
        message.type === 'destination-unreachable'
          ? `${code} (${UNREACHABLE_NAME[message.code]})`
          : '0',
      explain:
        message.type === 'destination-unreachable'
          ? UNREACHABLE_EXPLAIN[message.code]
          : 'Narrows the type down. This type has only code 0.',
      bytes: [code],
    },
    {
      id: 'icmpv6.checksum',
      label: 'Checksum',
      value: hex(checksum, 4),
      explain:
        'Covers the message and, through a pseudo-header, the IPv6 addresses, since IPv6 has no header checksum of its own.',
      bytes: u16(checksum),
    },
    ...body,
  ];
  const icmpv6: Section = {
    id: 'icmpv6',
    name: 'ICMPv6',
    summary: describeMessage(message),
    parts,
  };
  return quoted ? [icmpv6, quoted] : [icmpv6];
}

function hopLimitExplain(packet: Ipv6Packet) {
  return isNdp(packet.payload) && packet.hopLimit === NDP_HOP_LIMIT
    ? '255, the most there is. Neighbor Discovery always sends 255 and receivers drop any with less, which proves the message never crossed a router.'
    : 'IPv6’s TTL. Each router lowers it by one and drops the packet when it would reach 0, so a packet caught in a loop dies out.';
}

/** A packet as IPv6 header and ICMPv6 layers, outermost first, each with its fields in wire order. */
export function ipv6Sections(packet: Ipv6Packet): Section[] {
  const inner = icmpv6Sections(packet);
  const length = inner.flatMap((section) => section.parts).reduce((n, p) => n + p.bytes.length, 0);
  const header: Section = {
    id: 'ipv6',
    name: 'IPv6',
    summary: `${packet.src} → ${packet.dst}, hop limit ${packet.hopLimit}`,
    parts: [
      {
        id: 'ipv6.version',
        label: 'Version, class, flow',
        value: '6, 0, 0',
        explain:
          'IPv6, with traffic class 0 and no flow label: the packet asks for no special treatment.',
        bytes: [0x60, 0, 0, 0],
      },
      {
        id: 'ipv6.length',
        label: 'Payload length',
        value: `${length} bytes`,
        explain:
          'The size of what follows the header. Unlike IPv4’s total length, it leaves out the header, which is always 40 bytes.',
        bytes: u16(length),
      },
      {
        id: 'ipv6.next',
        label: 'Next header',
        value: `${IPV6_NEXT_HEADER.icmpv6} (ICMPv6)`,
        explain:
          'Names what follows the header, as IPv4’s protocol field does. ICMPv6 also carries Neighbor Discovery.',
        bytes: [IPV6_NEXT_HEADER.icmpv6],
      },
      {
        id: 'ipv6.hopLimit',
        label: 'Hop limit',
        value: String(packet.hopLimit),
        explain: hopLimitExplain(packet),
        bytes: [packet.hopLimit],
      },
      {
        id: 'ipv6.src',
        label: 'Source',
        value: packet.src,
        explain: describeAddress(packet.src, 'src'),
        bytes: ipv6Bytes(packet.src),
      },
      {
        id: 'ipv6.dst',
        label: 'Destination',
        value: packet.dst,
        explain: describeAddress(packet.dst, 'dst'),
        bytes: ipv6Bytes(packet.dst),
      },
    ],
  };
  return [header, ...inner];
}

/** A whole packet's bytes, header and payload. */
export const ipv6PacketBytes = (packet: Ipv6Packet): number[] =>
  ipv6Sections(packet).flatMap((section) => section.parts.flatMap((part) => part.bytes));
