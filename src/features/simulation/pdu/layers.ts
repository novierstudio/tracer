import type { Frame } from '@/engine/frame';
import {
  BROADCAST_MAC,
  DOT1Q_TPID,
  ETHER_TYPE,
  ICMP_TYPE,
  IP_PROTOCOL,
  PVST_MAC,
  UNKNOWN_MAC,
  UNREACHABLE_CODE,
  type ArpPacket,
  type Bpdu,
  type BridgeId,
  type EthernetFrame,
  type IcmpEcho,
  type IcmpMessage,
  type Ipv4Packet,
} from '@/engine/pdu';
import type { Ipv4Address, MacAddress } from '@/model';

/**
 * A frame taken apart for the PDU inspector: its layers, outermost first, each a list of labelled
 * fields with a plain-language explanation, and the bytes it would be on the wire. Each field
 * names the bytes it fills, so the inspector can link a field to its bytes and back.
 */
export type Dissection = { readonly layers: readonly Layer[]; readonly bytes: Uint8Array };

export type LayerId =
  | 'physical'
  | 'ethernet'
  | 'dot1q'
  | 'llc'
  | 'hdlc'
  | 'arp'
  | 'ipv4'
  | 'icmp'
  | 'quoted'
  | 'bpdu'
  | 'hello';

export type OsiLayer = 1 | 2 | 3;

export type Layer = {
  readonly id: LayerId;
  readonly osi: OsiLayer;
  readonly name: string;
  /** The layer in one line, for the layer list. */
  readonly summary: string;
  readonly fields: readonly Field[];
};

export type Field = {
  /** Stable across frames, such as `ipv4.ttl`, so a frame can be compared with the next hop's. */
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly explain: string;
  /** Bytes `start` up to `end`, not included. Absent for a field that is not on the wire. */
  readonly bytes?: readonly [start: number, end: number];
};

/** Collects bytes in wire order while layers declare the fields that fill them. */
class Wire {
  readonly data: number[] = [];

  field(id: string, label: string, value: string, explain: string, bytes: readonly number[]) {
    const start = this.data.length;
    this.data.push(...bytes);
    return { id, label, value, explain, bytes: [start, this.data.length] as const };
  }
}

const u16 = (value: number) => [(value >> 8) & 0xff, value & 0xff];
const u32 = (value: number) => [...u16(Math.floor(value / 0x10000)), ...u16(value & 0xffff)];
const macBytes = (mac: MacAddress) => mac.split(':').map((part) => parseInt(part, 16));
const ipBytes = (address: Ipv4Address) => address.split('.').map(Number);
const hex = (value: number, digits: number) =>
  `0x${value.toString(16).toUpperCase().padStart(digits, '0')}`;

/** The internet checksum: the ones' complement of the ones' complement sum of 16-bit words. */
export function internetChecksum(bytes: readonly number[]): number {
  let sum = 0;
  for (let index = 0; index < bytes.length; index += 2) {
    sum += (bytes[index]! << 8) | (bytes[index + 1] ?? 0);
  }
  while (sum > 0xffff) sum = (sum & 0xffff) + (sum >>> 16);
  return ~sum & 0xffff;
}

/** CRC-32 as Ethernet computes its frame check sequence. */
export function crc32(bytes: readonly number[]): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** CRC-16/X.25, the frame check sequence of HDLC. */
function crc16(bytes: readonly number[]): number {
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0x8408 : crc >>> 1;
  }
  return ~crc & 0xffff;
}

// ICMP

const isEcho = (message: IcmpMessage): message is IcmpEcho =>
  message.type === 'echo-request' || message.type === 'echo-reply';

const ICMP_NAMES: Record<IcmpMessage['type'], string> = {
  'echo-request': 'echo request',
  'echo-reply': 'echo reply',
  'destination-unreachable': 'destination unreachable',
  'time-exceeded': 'time exceeded',
};

const ICMP_EXPLAIN: Record<IcmpMessage['type'], string> = {
  'echo-request':
    'An echo request asks “are you there?”. The destination answers with an echo reply.',
  'echo-reply': 'An echo reply answers an echo request: the destination is reachable.',
  'destination-unreachable': 'A router or host could not deliver a packet and says why.',
  'time-exceeded': 'A router dropped a packet whose TTL ran out, and tells its sender.',
};

/** An ICMP message's bytes, with its checksum filled in. */
function icmpBytes(message: IcmpMessage): number[] {
  const code = message.type === 'destination-unreachable' ? UNREACHABLE_CODE[message.code] : 0;
  const rest = isEcho(message)
    ? [...u16(message.id), ...u16(message.seq)]
    : [0, 0, 0, 0, ...quotedBytes(message.original)];
  const body = [ICMP_TYPE[message.type], code, 0, 0, ...rest];
  const checksum = internetChecksum(body);
  body[2] = checksum >> 8;
  body[3] = checksum & 0xff;
  return body;
}

/** What an ICMP error quotes of the packet it is about: its header and first 8 bytes. */
const quotedBytes = (packet: Ipv4Packet) => ipv4Bytes(packet).slice(0, 28);

function ipv4Bytes(packet: Ipv4Packet): number[] {
  const payload = icmpBytes(packet.payload);
  const header = ipv4Header(packet, payload.length);
  return [...header, ...payload];
}

function ipv4Header(packet: Ipv4Packet, payloadLength: number): number[] {
  const header = [
    0x45,
    0,
    ...u16(20 + payloadLength),
    ...u16(packet.id),
    0,
    0,
    packet.ttl,
    IP_PROTOCOL[packet.payload.kind],
    0,
    0,
    ...ipBytes(packet.src),
    ...ipBytes(packet.dst),
  ];
  const checksum = internetChecksum(header);
  header[10] = checksum >> 8;
  header[11] = checksum & 0xff;
  return header;
}

function icmpLayers(wire: Wire, message: IcmpMessage): Layer[] {
  const bytes = icmpBytes(message);
  const name = ICMP_NAMES[message.type];
  const fields: Field[] = [
    wire.field(
      'icmp.type',
      'Type',
      `${ICMP_TYPE[message.type]} (${name})`,
      ICMP_EXPLAIN[message.type],
      bytes.slice(0, 1),
    ),
    wire.field(
      'icmp.code',
      'Code',
      message.type === 'destination-unreachable'
        ? `${UNREACHABLE_CODE[message.code]} (${message.code} unreachable)`
        : '0',
      message.type === 'destination-unreachable'
        ? message.code === 'network'
          ? 'Network unreachable: the router has no route to that network.'
          : 'Host unreachable: the network was found, but not the host on it.'
        : 'Narrows the type down. This type has only code 0.',
      bytes.slice(1, 2),
    ),
    wire.field(
      'icmp.checksum',
      'Checksum',
      hex((bytes[2]! << 8) | bytes[3]!, 4),
      'Lets the receiver spot an ICMP message damaged on the way.',
      bytes.slice(2, 4),
    ),
  ];
  if (isEcho(message)) {
    fields.push(
      wire.field(
        'icmp.id',
        'Identifier',
        String(message.id),
        'Tells apart pings running at once, so each reply finds the ping that sent its request.',
        bytes.slice(4, 6),
      ),
      wire.field(
        'icmp.seq',
        'Sequence',
        String(message.seq),
        'Counts the echoes of one ping, 1, 2, 3, so a lost one shows as a gap.',
        bytes.slice(6, 8),
      ),
    );
    return [
      {
        id: 'icmp',
        osi: 3,
        name: 'ICMP',
        summary: `${name[0]!.toUpperCase()}${name.slice(1)}, seq ${message.seq}`,
        fields,
      },
    ];
  }
  fields.push(
    wire.field(
      'icmp.unused',
      'Unused',
      '0',
      'Four bytes this type leaves empty.',
      bytes.slice(4, 8),
    ),
  );
  const { original } = message;
  const quoted: Layer = {
    id: 'quoted',
    osi: 3,
    name: 'Packet it is about',
    summary: `${original.src} → ${original.dst}, TTL ${original.ttl}`,
    fields: [
      wire.field(
        'quoted.header',
        'IPv4 header',
        `${original.src} → ${original.dst}, TTL ${original.ttl}`,
        'The header of the packet that failed, copied back so its sender can tell which one it was.',
        bytes.slice(8, 28),
      ),
      wire.field(
        'quoted.start',
        'First 8 bytes',
        describeIcmpStart(original.payload),
        'The start of that packet’s payload: for a ping, its identifier and sequence number.',
        bytes.slice(28, 36),
      ),
    ],
  };
  return [
    {
      id: 'icmp',
      osi: 3,
      name: 'ICMP',
      summary: `${name[0]!.toUpperCase()}${name.slice(1)}`,
      fields,
    },
    quoted,
  ];
}

function describeIcmpStart(message: IcmpMessage) {
  return isEcho(message)
    ? `ICMP ${ICMP_NAMES[message.type]}, id ${message.id}, seq ${message.seq}`
    : `ICMP ${ICMP_NAMES[message.type]}`;
}

// IPv4

function ipv4Layers(wire: Wire, packet: Ipv4Packet): Layer[] {
  const payload = icmpBytes(packet.payload);
  const header = ipv4Header(packet, payload.length);
  const fields: Field[] = [
    wire.field(
      'ipv4.version',
      'Version, header length',
      '4, 20 bytes',
      'IPv4, with the usual 20-byte header and no options.',
      header.slice(0, 1),
    ),
    wire.field(
      'ipv4.dscp',
      'Service type',
      '0 (best effort)',
      'A priority mark for quality of service. 0 asks for nothing special.',
      header.slice(1, 2),
    ),
    wire.field(
      'ipv4.length',
      'Total length',
      `${20 + payload.length} bytes`,
      'The packet’s size, header and payload together.',
      header.slice(2, 4),
    ),
    wire.field(
      'ipv4.id',
      'Identification',
      String(packet.id),
      'A number the sender gives each packet, so the pieces of a fragmented one can be put back together.',
      header.slice(4, 6),
    ),
    wire.field(
      'ipv4.fragment',
      'Flags, fragment offset',
      'Not fragmented',
      'The packet travels in one piece.',
      header.slice(6, 8),
    ),
    wire.field(
      'ipv4.ttl',
      'TTL',
      String(packet.ttl),
      'Time to live. Each router lowers it by one and drops the packet when it would reach 0, so a packet caught in a loop dies out.',
      header.slice(8, 9),
    ),
    wire.field(
      'ipv4.protocol',
      'Protocol',
      `${IP_PROTOCOL[packet.payload.kind]} (ICMP)`,
      'Names what the packet carries, so the receiver hands it to the right protocol.',
      header.slice(9, 10),
    ),
    wire.field(
      'ipv4.checksum',
      'Header checksum',
      hex((header[10]! << 8) | header[11]!, 4),
      'Covers the header only. Each router recomputes it, since it changes the TTL.',
      header.slice(10, 12),
    ),
    wire.field(
      'ipv4.src',
      'Source',
      packet.src,
      'The device that created the packet. It stays the same all the way.',
      header.slice(12, 16),
    ),
    wire.field(
      'ipv4.dst',
      'Destination',
      packet.dst,
      'Where the packet is going. Every router looks it up in its routing table.',
      header.slice(16, 20),
    ),
  ];
  return [
    {
      id: 'ipv4',
      osi: 3,
      name: 'IPv4',
      summary: `${packet.src} → ${packet.dst}, TTL ${packet.ttl}`,
      fields,
    },
    ...icmpLayers(wire, packet.payload),
  ];
}

// ARP

function arpLayers(wire: Wire, arp: ArpPacket): Layer[] {
  const request = arp.op === 'request';
  const fields: Field[] = [
    wire.field(
      'arp.htype',
      'Hardware type',
      '1 (Ethernet)',
      'The kind of address being asked for: an Ethernet MAC.',
      u16(1),
    ),
    wire.field(
      'arp.ptype',
      'Protocol type',
      `${hex(ETHER_TYPE.ipv4, 4)} (IPv4)`,
      'The kind of address it is asked by: an IPv4 address.',
      u16(ETHER_TYPE.ipv4),
    ),
    wire.field('arp.hlen', 'Hardware size', '6', 'A MAC address is 6 bytes long.', [6]),
    wire.field('arp.plen', 'Protocol size', '4', 'An IPv4 address is 4 bytes long.', [4]),
    wire.field(
      'arp.op',
      'Operation',
      request ? '1 (request)' : '2 (reply)',
      request
        ? 'A request asks the whole LAN: who has the target IP?'
        : 'A reply answers a request, straight to whoever asked.',
      u16(request ? 1 : 2),
    ),
    wire.field(
      'arp.senderMac',
      'Sender MAC',
      arp.senderMac,
      request
        ? 'The asker’s own MAC, so the answer can come straight back.'
        : 'The answer: the MAC that owns the IP that was asked for.',
      macBytes(arp.senderMac),
    ),
    wire.field(
      'arp.senderIp',
      'Sender IP',
      arp.senderIp,
      request ? 'The asker’s own IP address.' : 'The IP address that was asked for.',
      ipBytes(arp.senderIp),
    ),
    wire.field(
      'arp.targetMac',
      'Target MAC',
      arp.targetMac,
      arp.targetMac === UNKNOWN_MAC
        ? 'All zeros: this is the unknown the request asks for.'
        : 'The MAC of the device that asked.',
      macBytes(arp.targetMac),
    ),
    wire.field(
      'arp.targetIp',
      'Target IP',
      arp.targetIp,
      request
        ? 'The IP address whose MAC the asker needs. Only its owner answers.'
        : 'The IP address of the device that asked.',
      ipBytes(arp.targetIp),
    ),
  ];
  return [
    {
      id: 'arp',
      osi: 2,
      name: 'ARP',
      summary: request
        ? `Who has ${arp.targetIp}? Tell ${arp.senderIp}`
        : `${arp.senderIp} is at ${arp.senderMac}`,
      fields,
    },
  ];
}

// Spanning tree

const bridgeBytes = ({ priority, mac }: BridgeId) => [...u16(priority), ...macBytes(mac)];
const seconds = (value: number) => u16(Math.round(value * 256));

function bpduLayers(wire: Wire, bpdu: Bpdu): Layer[] {
  const common = [
    wire.field(
      'bpdu.protocol',
      'Protocol',
      '0 (spanning tree)',
      'Marks the frame as a spanning tree BPDU.',
      u16(0),
    ),
    wire.field('bpdu.version', 'Version', '0 (802.1D)', 'Classic spanning tree.', [0]),
    wire.field(
      'bpdu.type',
      'Type',
      bpdu.type === 'tcn' ? `${hex(0x80, 2)} (topology change)` : `${hex(0, 2)} (configuration)`,
      bpdu.type === 'tcn'
        ? 'Tells the root that a port somewhere went up or down.'
        : 'Says which bridge is the root and how far away it is.',
      [bpdu.type === 'tcn' ? 0x80 : 0],
    ),
  ];
  if (bpdu.type === 'tcn') {
    return [
      {
        id: 'bpdu',
        osi: 2,
        name: 'Spanning tree',
        summary: 'Topology change notification',
        fields: common,
      },
    ];
  }
  const flags = (bpdu.topologyChange ? 0x01 : 0) | (bpdu.topologyChangeAck ? 0x80 : 0);
  const flagText =
    [bpdu.topologyChange && 'topology change', bpdu.topologyChangeAck && 'ack']
      .filter(Boolean)
      .join(', ') || 'none';
  const bridge = (id: BridgeId) => `${id.priority} ${id.mac}`;
  const fields = [
    ...common,
    wire.field(
      'bpdu.flags',
      'Flags',
      flagText,
      'A topology change makes switches forget learned addresses sooner.',
      [flags],
    ),
    wire.field(
      'bpdu.root',
      'Root bridge',
      bridge(bpdu.root),
      'The bridge this switch believes is the root: the lowest priority, then the lowest MAC.',
      bridgeBytes(bpdu.root),
    ),
    wire.field(
      'bpdu.cost',
      'Root path cost',
      String(bpdu.rootPathCost),
      'How far the sender is from the root. Faster links cost less.',
      u32(bpdu.rootPathCost),
    ),
    wire.field(
      'bpdu.bridge',
      'Sender bridge',
      bridge(bpdu.bridge),
      'The switch that sent this BPDU.',
      bridgeBytes(bpdu.bridge),
    ),
    wire.field(
      'bpdu.port',
      'Sender port',
      `${bpdu.port.priority}.${bpdu.port.number}`,
      'The port it left by: priority, then number. Lower wins a tie.',
      u16(bpdu.port.priority * 256 + bpdu.port.number),
    ),
    wire.field(
      'bpdu.age',
      'Message age',
      `${bpdu.messageAge} s`,
      'How old the root’s information is. Each switch that relays it adds one.',
      seconds(bpdu.messageAge),
    ),
    wire.field(
      'bpdu.maxAge',
      'Max age',
      `${bpdu.maxAge} s`,
      'Information older than this is thrown away.',
      seconds(bpdu.maxAge),
    ),
    wire.field(
      'bpdu.hello',
      'Hello time',
      `${bpdu.helloTime} s`,
      'How often the root sends a BPDU.',
      seconds(bpdu.helloTime),
    ),
    wire.field(
      'bpdu.forwardDelay',
      'Forward delay',
      `${bpdu.forwardDelay} s`,
      'How long a port listens, then learns, before it forwards.',
      seconds(bpdu.forwardDelay),
    ),
  ];
  return [
    {
      id: 'bpdu',
      osi: 2,
      name: 'Spanning tree',
      summary: `Root ${bridge(bpdu.root)}, cost ${bpdu.rootPathCost}`,
      fields,
    },
  ];
}

// Ethernet

function describeMac(mac: MacAddress, role: 'dst' | 'src') {
  if (role === 'src') {
    return 'The port that put the frame on this wire. Switches learn where this MAC lives from it.';
  }
  if (mac === BROADCAST_MAC) return 'All ones: a broadcast, which every device on the LAN takes.';
  if (mac === PVST_MAC) return 'Cisco’s spanning tree address: only switches listen for it.';
  return 'The next device on this LAN that should take the frame. A router rewrites it at every hop.';
}

const MIN_PAYLOAD = 46;

function ethernetLayers(wire: Wire, frame: EthernetFrame): Layer[] {
  const { payload, tag } = frame;
  const dst = wire.field(
    'ethernet.dst',
    'Destination MAC',
    frame.dst,
    describeMac(frame.dst, 'dst'),
    macBytes(frame.dst),
  );
  const src = wire.field(
    'ethernet.src',
    'Source MAC',
    frame.src,
    describeMac(frame.src, 'src'),
    macBytes(frame.src),
  );
  const tagLayer: Layer | undefined = tag && {
    id: 'dot1q',
    osi: 2,
    name: '802.1Q tag',
    summary: `VLAN ${tag.vlan}`,
    fields: [
      wire.field(
        'dot1q.tpid',
        'Tag type',
        `${hex(DOT1Q_TPID, 4)} (802.1Q)`,
        'Says a VLAN tag follows. A trunk adds it so the next switch knows the frame’s VLAN.',
        u16(DOT1Q_TPID),
      ),
      wire.field(
        'dot1q.vlan',
        'VLAN',
        String(tag.vlan),
        'The VLAN the frame belongs to. The last switch removes the tag before an access port.',
        u16(tag.vlan),
      ),
    ],
  };

  const inner: Layer[] = [];
  const bodyStart = wire.data.length + 2;
  let typeField: Field;
  if (payload.kind === 'bpdu') {
    // LLC and SNAP, then a configuration BPDU's 35 bytes or a notification's 4.
    const bpduLength = 8 + (payload.type === 'tcn' ? 4 : 35);
    typeField = wire.field(
      'ethernet.type',
      'Length',
      `${bpduLength} bytes`,
      'A number of 1500 or less is a length, not a type: this is an 802.3 frame, as BPDUs use.',
      u16(bpduLength),
    );
    inner.push({
      id: 'llc',
      osi: 2,
      name: 'LLC and SNAP',
      summary: 'Cisco PVST+',
      fields: [
        wire.field(
          'llc.header',
          'LLC',
          'AA AA 03',
          'Says a SNAP header follows, since an 802.3 frame has no EtherType.',
          [0xaa, 0xaa, 0x03],
        ),
        wire.field(
          'llc.snap',
          'SNAP',
          'Cisco, PVST+',
          'Names Cisco’s per-VLAN spanning tree as the protocol inside.',
          [0x00, 0x00, 0x0c, 0x01, 0x0b],
        ),
      ],
    });
    inner.push(...bpduLayers(wire, payload));
  } else {
    typeField = wire.field(
      'ethernet.type',
      'EtherType',
      `${hex(ETHER_TYPE[payload.kind], 4)} (${payload.kind === 'arp' ? 'ARP' : 'IPv4'})`,
      'Names what the frame carries, so the receiver hands it to the right protocol.',
      u16(ETHER_TYPE[payload.kind]),
    );
    inner.push(...(payload.kind === 'arp' ? arpLayers(wire, payload) : ipv4Layers(wire, payload)));
  }

  const trailer: Field[] = [];
  const short = MIN_PAYLOAD - (tag ? 4 : 0) - (wire.data.length - bodyStart);
  if (short > 0) {
    trailer.push(
      wire.field(
        'ethernet.padding',
        'Padding',
        `${short} zero bytes`,
        'Ethernet frames have a minimum size, so a short one is padded with zeros.',
        new Array<number>(short).fill(0),
      ),
    );
  }
  const fcs = crc32(wire.data);
  trailer.push(
    wire.field(
      'ethernet.fcs',
      'Frame check',
      hex(fcs, 8),
      'A checksum of the whole frame. The receiver recomputes it and throws the frame away if it differs.',
      [fcs & 0xff, (fcs >> 8) & 0xff, (fcs >> 16) & 0xff, fcs >>> 24],
    ),
  );

  const ethernet: Layer = {
    id: 'ethernet',
    osi: 2,
    name: payload.kind === 'bpdu' ? 'Ethernet 802.3' : 'Ethernet II',
    summary: `${frame.src} → ${frame.dst === BROADCAST_MAC ? 'broadcast' : frame.dst}`,
    fields: [dst, src, typeField, ...trailer],
  };
  return [ethernet, ...(tagLayer ? [tagLayer] : []), ...inner];
}

// HDLC

function hdlcLayers(wire: Wire, packet: Ipv4Packet): Layer[] {
  const flag = (id: string) =>
    wire.field(id, 'Flag', hex(0x7e, 2), 'Marks where an HDLC frame begins and ends.', [0x7e]);
  const fields = [
    flag('hdlc.open'),
    wire.field(
      'hdlc.address',
      'Address',
      `${hex(0x0f, 2)} (unicast)`,
      'A serial link has one device at each end, so there is no MAC: Cisco HDLC just marks it unicast.',
      [0x0f],
    ),
    wire.field('hdlc.control', 'Control', hex(0, 2), 'Unused by Cisco HDLC.', [0]),
    wire.field(
      'hdlc.protocol',
      'Protocol',
      `${hex(ETHER_TYPE.ipv4, 4)} (IPv4)`,
      'Names what the frame carries, as an EtherType does on Ethernet.',
      u16(ETHER_TYPE.ipv4),
    ),
  ];
  const inner = ipv4Layers(wire, packet);
  const fcs = crc16(wire.data.slice(1));
  fields.push(
    wire.field(
      'hdlc.fcs',
      'Frame check',
      hex(fcs, 4),
      'A checksum of the frame. The far end drops the frame if it does not match.',
      [fcs & 0xff, fcs >> 8],
    ),
    flag('hdlc.close'),
  );
  return [
    { id: 'hdlc', osi: 2, name: 'Cisco HDLC', summary: 'Serial link, IPv4 inside', fields },
    ...inner,
  ];
}

/** Takes a frame apart into its layers and its bytes. */
export function dissect(frame: Frame): Dissection {
  const wire = new Wire();
  let layers: Layer[];
  switch (frame.kind) {
    case 'ethernet':
      layers = ethernetLayers(wire, frame);
      break;
    case 'hdlc':
      layers = hdlcLayers(wire, frame.payload);
      break;
    case 'hello':
      layers = [
        {
          id: 'hello',
          osi: 2,
          name: 'Link test',
          summary: `Test ${frame.seq}`,
          fields: [
            {
              id: 'hello.seq',
              label: 'Sequence',
              value: String(frame.seq),
              explain: 'Tracer’s own test frame. It proves that a frame crosses the link.',
            },
          ],
        },
      ];
      break;
  }
  return { layers, bytes: Uint8Array.from(wire.data) };
}
