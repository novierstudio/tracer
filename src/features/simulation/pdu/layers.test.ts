import { describe, expect, it } from 'vitest';
import type { Frame } from '@/engine/frame';
import {
  ALL_D_ROUTERS,
  ALL_SPF_ROUTERS,
  BROADCAST_MAC,
  LIMITED_BROADCAST,
  multicastMac,
  PVST_MAC,
  RIP_GROUP,
  UNKNOWN_MAC,
  UNSPECIFIED_ADDRESS,
  type DhcpMessage,
  type Ipv4Packet,
  type OspfPacket,
} from '@/engine/pdu';
import type { Ipv4Address, MacAddress, PrefixLength, VlanId } from '@/model';
import {
  ospfAck,
  ospfDbd,
  ospfHello,
  ospfLsr,
  ospfLsu,
  ospfPacket,
  ripPacket,
  ripRequest,
  ripV1Response,
  ripV2Response,
} from '../testing';
import { crc32, dissect, formatLeaseTime, internetChecksum, type Dissection } from './layers';

const mac = (n: number) => `02:00:00:00:00:0${n}` as MacAddress;
const ip = (text: string) => text as Ipv4Address;

const echo: Ipv4Packet = {
  kind: 'ipv4',
  src: ip('192.168.1.10'),
  dst: ip('192.168.2.10'),
  ttl: 128,
  id: 1,
  payload: { kind: 'icmp', type: 'echo-request', id: 1, seq: 3 },
};

const arpRequest: Frame = {
  kind: 'ethernet',
  dst: BROADCAST_MAC,
  src: mac(1),
  payload: {
    kind: 'arp',
    op: 'request',
    senderMac: mac(1),
    senderIp: ip('192.168.1.10'),
    targetMac: UNKNOWN_MAC,
    targetIp: ip('192.168.1.1'),
  },
};

const timeExceeded: Frame = {
  kind: 'ethernet',
  dst: mac(1),
  src: mac(2),
  payload: {
    kind: 'ipv4',
    src: ip('192.168.1.1'),
    dst: ip('192.168.1.10'),
    ttl: 255,
    id: 9,
    payload: { kind: 'icmp', type: 'time-exceeded', original: { ...echo, ttl: 1 } },
  },
};

const bpdu: Frame = {
  kind: 'ethernet',
  dst: PVST_MAC,
  src: mac(3),
  payload: {
    kind: 'bpdu',
    type: 'config',
    root: { priority: 32769, mac: mac(3) },
    rootPathCost: 0,
    bridge: { priority: 32769, mac: mac(3) },
    port: { priority: 128, number: 1 },
    messageAge: 0,
    maxAge: 20,
    helloTime: 2,
    forwardDelay: 15,
    topologyChange: false,
    topologyChangeAck: false,
  },
};

const dhcpHeader = {
  kind: 'dhcp',
  xid: 0x3903f326,
  hops: 0,
  broadcast: true,
  ciaddr: UNSPECIFIED_ADDRESS,
  yiaddr: UNSPECIFIED_ADDRESS,
  giaddr: UNSPECIFIED_ADDRESS,
  chaddr: mac(1),
} as const;

/** A DHCP message broadcast on the LAN, from the client's port or the server's. */
function dhcpFrame(message: DhcpMessage, fromClient: boolean): Frame {
  return {
    kind: 'ethernet',
    dst: BROADCAST_MAC,
    src: fromClient ? mac(1) : mac(2),
    payload: {
      kind: 'ipv4',
      src: fromClient ? UNSPECIFIED_ADDRESS : ip('192.168.1.1'),
      dst: LIMITED_BROADCAST,
      ttl: fromClient ? 128 : 255,
      id: 1,
      payload: {
        kind: 'udp',
        srcPort: fromClient ? 68 : 67,
        dstPort: fromClient ? 67 : 68,
        payload: message,
      },
    },
  };
}

const offer = dhcpFrame(
  {
    ...dhcpHeader,
    type: 'offer',
    yiaddr: ip('192.168.1.11'),
    serverId: ip('192.168.1.1'),
    leaseTime: 86400,
    subnetMask: 24 as PrefixLength,
    routers: [ip('192.168.1.1')],
    dnsServers: [ip('8.8.8.8'), ip('8.8.4.4')],
  },
  false,
);

const RIP_MAC = multicastMac(RIP_GROUP);

const ripV2: Frame = {
  kind: 'ethernet',
  dst: RIP_MAC,
  src: mac(1),
  payload: ripPacket(ripV2Response),
};
const ripV1: Frame = {
  kind: 'ethernet',
  dst: BROADCAST_MAC,
  src: mac(1),
  payload: ripPacket(ripV1Response),
};
const ripV2Request: Frame = {
  kind: 'ethernet',
  dst: RIP_MAC,
  src: mac(1),
  payload: ripPacket(ripRequest(2)),
};

/** An OSPF packet in an untagged Ethernet frame to its group's MAC. */
const ospfFrame = (packet: OspfPacket, dst: Ipv4Address = ALL_SPF_ROUTERS): Frame => ({
  kind: 'ethernet',
  dst: multicastMac(dst),
  src: mac(1),
  payload: ospfPacket(packet, dst),
});

/** Every PDU kind the engine sends, by name. */
const FRAMES: Record<string, Frame> = {
  'ARP request': arpRequest,
  'ICMP echo': { kind: 'ethernet', dst: mac(2), src: mac(1), payload: echo },
  'ICMP time exceeded': timeExceeded,
  '802.1Q tagged echo': {
    kind: 'ethernet',
    dst: mac(2),
    src: mac(1),
    tag: { vlan: 10 as VlanId },
    payload: echo,
  },
  'HDLC echo': { kind: 'hdlc', payload: echo },
  'STP BPDU': bpdu,
  'STP topology change': { ...bpdu, payload: { kind: 'bpdu', type: 'tcn' } },
  'RIPv2 response': ripV2,
  'RIPv1 response': ripV1,
  'RIPv2 request': ripV2Request,
  'HDLC RIPv1 request': { kind: 'hdlc', payload: ripPacket(ripRequest(1)) },
  'DHCP Discover': dhcpFrame({ ...dhcpHeader, type: 'discover' }, true),
  'DHCP Offer': offer,
  'DHCP Request': dhcpFrame(
    {
      ...dhcpHeader,
      type: 'request',
      requestedIp: ip('192.168.1.11'),
      serverId: ip('192.168.1.1'),
    },
    true,
  ),
  'DHCP Ack': dhcpFrame(
    {
      ...dhcpHeader,
      type: 'ack',
      yiaddr: ip('192.168.1.11'),
      serverId: ip('192.168.1.1'),
      leaseTime: 'infinite',
      subnetMask: 24 as PrefixLength,
      routers: [],
      dnsServers: [],
    },
    false,
  ),
  'DHCP Nak': dhcpFrame({ ...dhcpHeader, type: 'nak', serverId: ip('192.168.1.1') }, false),
  'DHCP Release': dhcpFrame(
    { ...dhcpHeader, type: 'release', ciaddr: ip('192.168.1.11'), serverId: ip('192.168.1.1') },
    true,
  ),
  'OSPF hello': ospfFrame(ospfHello),
  'OSPF DBD': { kind: 'hdlc', payload: ospfPacket(ospfDbd, '10.0.13.3' as Ipv4Address) },
  'OSPF LS request': ospfFrame(ospfLsr, '10.0.12.2' as Ipv4Address),
  'OSPF LS update': ospfFrame(ospfLsu, ALL_D_ROUTERS),
  'OSPF LS ack': ospfFrame(ospfAck),
};

const fieldsOf = (dissection: Dissection) => dissection.layers.flatMap((layer) => layer.fields);
const field = (dissection: Dissection, id: string) =>
  fieldsOf(dissection).find((candidate) => candidate.id === id);
const bytesOf = (dissection: Dissection, id: string) => {
  const [start, end] = field(dissection, id)!.bytes!;
  return [...dissection.bytes.slice(start, end)];
};

describe('dissect', () => {
  it.each(Object.entries(FRAMES))('labels and explains every field of an %s', (_, frame) => {
    const dissection = dissect(frame);
    for (const { label, value, explain } of fieldsOf(dissection)) {
      expect(label).not.toBe('');
      expect(value).not.toBe('');
      expect(explain).toMatch(/[.?]$/);
    }
  });

  it.each(Object.entries(FRAMES))('gives each byte of an %s to exactly one field', (_, frame) => {
    const dissection = dissect(frame);
    const ranges = fieldsOf(dissection)
      .flatMap((f) => (f.bytes ? [f.bytes] : []))
      .sort((a, b) => a[0] - b[0]);
    let next = 0;
    for (const [start, end] of ranges) {
      expect(start).toBe(next);
      expect(end).toBeGreaterThan(start);
      next = end;
    }
    expect(next).toBe(dissection.bytes.length);
  });

  it('lays an ARP request out as Ethernet and ARP, padded to the minimum frame size', () => {
    const dissection = dissect(arpRequest);
    expect(dissection.layers.map((layer) => layer.name)).toEqual(['Ethernet II', 'ARP']);
    expect(dissection.bytes.length).toBe(64);
    expect(bytesOf(dissection, 'ethernet.dst')).toEqual([255, 255, 255, 255, 255, 255]);
    expect(bytesOf(dissection, 'ethernet.type')).toEqual([0x08, 0x06]);
    expect(bytesOf(dissection, 'arp.op')).toEqual([0, 1]);
    expect(field(dissection, 'arp.op')!.value).toBe('1 (request)');
    expect(field(dissection, 'arp.targetIp')!.value).toBe('192.168.1.1');
    expect(field(dissection, 'ethernet.dst')!.explain).toMatch(/broadcast/);
    expect(field(dissection, 'arp.targetMac')!.explain).toMatch(/All zeros/);
    expect(field(dissection, 'ethernet.padding')!.value).toBe('18 zero bytes');
  });

  it('writes a valid IPv4 header checksum and Ethernet frame check', () => {
    const { bytes } = dissect(FRAMES['ICMP echo']!);
    const header = [...bytes.slice(14, 34)];
    expect(internetChecksum(header)).toBe(0);
    expect(internetChecksum([...bytes.slice(34, 42)])).toBe(0);
    const body = [...bytes.slice(0, -4)];
    const fcs = crc32(body);
    expect([...bytes.slice(-4)]).toEqual([
      fcs & 0xff,
      (fcs >> 8) & 0xff,
      (fcs >> 16) & 0xff,
      fcs >>> 24,
    ]);
  });

  it('computes the checksums as the standards define them', () => {
    // RFC 1071's worked example, and CRC-32's check value for "123456789".
    expect(internetChecksum([0x00, 0x01, 0xf2, 0x03, 0xf4, 0xf5, 0xf6, 0xf7])).toBe(
      ~0xddf2 & 0xffff,
    );
    expect(crc32([...'123456789'].map((c) => c.charCodeAt(0)))).toBe(0xcbf43926);
  });

  it('shows the TTL and the echo it carries', () => {
    const dissection = dissect(FRAMES['ICMP echo']!);
    expect(dissection.layers.map((layer) => layer.name)).toEqual(['Ethernet II', 'IPv4', 'ICMP']);
    expect(field(dissection, 'ipv4.ttl')!.value).toBe('128');
    expect(bytesOf(dissection, 'ipv4.ttl')).toEqual([128]);
    expect(field(dissection, 'icmp.type')!.value).toBe('8 (echo request)');
    expect(field(dissection, 'icmp.seq')!.value).toBe('3');
  });

  it('puts the 802.1Q tag between the source MAC and the EtherType', () => {
    const dissection = dissect(FRAMES['802.1Q tagged echo']!);
    expect(dissection.layers.map((layer) => layer.name)).toEqual([
      'Ethernet II',
      '802.1Q tag',
      'IPv4',
      'ICMP',
    ]);
    expect(field(dissection, 'dot1q.tpid')!.bytes).toEqual([12, 14]);
    expect(bytesOf(dissection, 'dot1q.tpid')).toEqual([0x81, 0x00]);
    expect(bytesOf(dissection, 'dot1q.vlan')).toEqual([0, 10]);
    expect(field(dissection, 'ethernet.type')!.bytes).toEqual([16, 18]);
    expect(field(dissection, 'dot1q.vlan')!.value).toBe('10');
  });

  it('quotes the packet an ICMP error is about', () => {
    const dissection = dissect(timeExceeded);
    expect(dissection.layers.map((layer) => layer.name)).toEqual([
      'Ethernet II',
      'IPv4',
      'ICMP',
      'Packet it is about',
    ]);
    expect(field(dissection, 'icmp.type')!.value).toBe('11 (time exceeded)');
    expect(field(dissection, 'quoted.header')!.value).toBe('192.168.1.10 → 192.168.2.10, TTL 1');
    expect(bytesOf(dissection, 'quoted.header')[8]).toBe(1);
  });

  it('frames a packet on a serial link in Cisco HDLC, with no MAC addresses', () => {
    const dissection = dissect(FRAMES['HDLC echo']!);
    expect(dissection.layers.map((layer) => layer.name)).toEqual(['Cisco HDLC', 'IPv4', 'ICMP']);
    expect(dissection.bytes[0]).toBe(0x7e);
    expect(dissection.bytes.at(-1)).toBe(0x7e);
    expect(fieldsOf(dissection).some((f) => f.id.startsWith('ethernet'))).toBe(false);
  });

  it('lays a DHCP Offer out as UDP inside IPv4, with BOOTP fields and options', () => {
    const dissection = dissect(offer);
    expect(dissection.layers.map((layer) => [layer.name, layer.osi])).toEqual([
      ['Ethernet II', 2],
      ['IPv4', 3],
      ['UDP', 4],
      ['DHCP', 7],
    ]);
    expect(field(dissection, 'ipv4.protocol')!.value).toBe('17 (UDP)');
    expect(field(dissection, 'ipv4.dst')!.explain).toMatch(/every host/);
    expect(field(dissection, 'udp.srcPort')!.value).toBe('67 (DHCP server)');
    expect(field(dissection, 'udp.dstPort')!.value).toBe('68 (DHCP client)');
    expect(field(dissection, 'dhcp.op')!.value).toBe('2 (reply)');
    expect(field(dissection, 'dhcp.yiaddr')!.value).toBe('192.168.1.11');
    expect(field(dissection, 'dhcp.option.53')!.value).toBe('2 (Offer)');
    expect(bytesOf(dissection, 'dhcp.option.53')).toEqual([53, 1, 2]);
    expect(bytesOf(dissection, 'dhcp.option.1')).toEqual([1, 4, 255, 255, 255, 0]);
    expect(field(dissection, 'dhcp.option.6')!.value).toBe('8.8.8.8, 8.8.4.4');
    expect(field(dissection, 'dhcp.option.51')!.value).toBe('86400 s (1 day)');
    expect(bytesOf(dissection, 'dhcp.xid')).toEqual([0x39, 0x03, 0xf3, 0x26]);
    expect(bytesOf(dissection, 'dhcp.flags')).toEqual([0x80, 0]);
    expect(bytesOf(dissection, 'dhcp.cookie')).toEqual([0x63, 0x82, 0x53, 0x63]);
    // BOOTP's fixed part is 236 bytes, the magic cookie 4.
    expect(
      field(dissection, 'dhcp.cookie')!.bytes![0] - field(dissection, 'dhcp.op')!.bytes![0],
    ).toBe(236);
  });

  it('writes a UDP checksum that verifies over the pseudo-header', () => {
    const { bytes } = dissect(offer);
    const ipHeader = [...bytes.slice(14, 34)];
    const udp = [...bytes.slice(34, -4)];
    const pseudo = [...ipHeader.slice(12, 20), 0, 17, udp.length >> 8, udp.length & 0xff];
    expect(udp.length).toBe((udp[4]! << 8) | udp[5]!);
    expect(internetChecksum([...pseudo, ...udp])).toBe(0);
  });

  it('says a lease of all ones lasts forever', () => {
    const dissection = dissect(FRAMES['DHCP Ack']!);
    expect(field(dissection, 'dhcp.option.51')!.value).toBe('Infinite');
    expect(bytesOf(dissection, 'dhcp.option.51')).toEqual([51, 4, 255, 255, 255, 255]);
    expect(field(dissection, 'dhcp.option.3')).toBeUndefined();
  });

  it('writes a lease in seconds and the units a student reads', () => {
    expect(formatLeaseTime(5400)).toBe('5400 s (1 hour 30 minutes)');
    expect(formatLeaseTime(60)).toBe('60 s (1 minute)');
  });

  it('reads a BPDU as an 802.3 frame with LLC and SNAP', () => {
    const dissection = dissect(bpdu);
    expect(dissection.layers.map((layer) => layer.name)).toEqual([
      'Ethernet 802.3',
      'LLC and SNAP',
      'Spanning tree',
    ]);
    expect(field(dissection, 'ethernet.type')!.value).toBe('43 bytes');
    expect(field(dissection, 'bpdu.root')!.value).toBe(`32769 ${mac(3)}`);
    expect(bytesOf(dissection, 'bpdu.port')).toEqual([0x80, 0x01]);
    expect(bytesOf(dissection, 'bpdu.hello')).toEqual([2, 0]);
  });
});

/** Where UDP starts in an untagged Ethernet frame: after 14 bytes of Ethernet and 20 of IPv4. */
const UDP_START = 34;
const RIP_START = UDP_START + 8;
const ENTRY = 20;

/** The UDP segment with the pseudo-header the checksum covers: addresses, protocol, length. */
function pseudoAndUdp(bytes: Uint8Array) {
  const udpLength = (bytes[UDP_START + 4]! << 8) | bytes[UDP_START + 5]!;
  return [
    ...bytes.slice(26, 34),
    0,
    17,
    udpLength >> 8,
    udpLength & 0xff,
    ...bytes.slice(UDP_START, UDP_START + udpLength),
  ];
}

describe('dissect a RIP message', () => {
  it('stacks UDP at layer 4 and RIP at layer 7 over IPv4', () => {
    const dissection = dissect(ripV2);
    expect(dissection.layers.map((layer) => [layer.name, layer.osi])).toEqual([
      ['Ethernet II', 2],
      ['IPv4', 3],
      ['UDP', 4],
      ['RIPv2', 7],
    ]);
    expect(dissection.layers.at(-1)!.summary).toBe('Response, 3 routes');
    expect(field(dissection, 'ipv4.protocol')!.value).toBe('17 (UDP)');
    expect(bytesOf(dissection, 'ipv4.protocol')).toEqual([17]);
  });

  it('lays out a RIPv2 response: ports 520, a 72-byte datagram, and 20 bytes a route', () => {
    const { bytes } = dissect(ripV2);
    expect([...bytes.slice(UDP_START, UDP_START + 6)]).toEqual([0x02, 0x08, 0x02, 0x08, 0, 72]);
    expect([...bytes.slice(16, 18)]).toEqual([0, 20 + 72]);
    expect([...bytes.slice(RIP_START, RIP_START + 4)]).toEqual([2, 2, 0, 0]);
    const route = (n: number) => [
      ...bytes.slice(RIP_START + 4 + n * ENTRY, RIP_START + 4 + (n + 1) * ENTRY),
    ];
    expect(route(0)).toEqual([
      ...[0, 2, 0, 0],
      ...[192, 168, 1, 0],
      ...[255, 255, 255, 0],
      ...[0, 0, 0, 0],
      ...[0, 0, 0, 1],
    ]);
    expect(route(1).slice(8, 12)).toEqual([255, 255, 255, 252]);
    expect(route(2).slice(16)).toEqual([0, 0, 0, 16]);
    expect(bytes.length).toBe(14 + 20 + 72 + 4);
  });

  it('writes a UDP checksum over the IPv4 pseudo-header', () => {
    for (const frame of [ripV2, ripV1, ripV2Request]) {
      const { bytes } = dissect(frame);
      expect(internetChecksum(pseudoAndUdp(bytes))).toBe(0);
    }
    // Worked by hand for the request from 10.0.12.1 to 224.0.0.9.
    const request = dissect(ripV2Request);
    expect(bytesOf(request, 'udp.checksum')).toEqual([0x04, 0x82]);
    expect(field(request, 'udp.checksum')!.value).toBe('0x0482');
  });

  it('names the ports and explains the fields of each route', () => {
    const dissection = dissect(ripV2);
    expect(field(dissection, 'udp.srcPort')!.value).toBe('520 (RIP)');
    expect(field(dissection, 'udp.dstPort')!.explain).toMatch(/RIP on 520/);
    expect(field(dissection, 'udp.length')!.value).toBe('72 bytes');
    expect(field(dissection, 'rip.command')!.value).toBe('2 (response)');
    expect(field(dissection, 'rip.1.address')!.label).toBe('Route 1 network');
    expect(field(dissection, 'rip.1.mask')!.value).toBe('255.255.255.0 (/24)');
    expect(field(dissection, 'rip.2.metric')!.value).toBe('2 hops');
    expect(field(dissection, 'rip.3.metric')!.value).toBe('16 (unreachable)');
    expect(field(dissection, 'rip.3.metric')!.explain).toMatch(/unreachable/);
    expect(field(dissection, 'ipv4.dst')!.explain).toMatch(/RIPv2/);
  });

  it('explains the multicast MAC of RIPv2’s group', () => {
    const explain = field(dissect(ripV2), 'ethernet.dst')!.explain;
    expect(explain).toMatch(/224\.0\.0\.9/);
    const other = { ...ripV2, dst: multicastMac('224.0.0.18' as Ipv4Address) };
    expect(field(dissect(other), 'ethernet.dst')!.explain).toMatch(/multicast/);
    expect(field(dissect(other), 'ethernet.dst')!.explain).not.toMatch(/RIP/);
  });

  it('leaves the mask and next hop of a RIPv1 route empty', () => {
    const dissection = dissect(ripV1);
    expect(dissection.layers.at(-1)!.name).toBe('RIPv1');
    expect(bytesOf(dissection, 'rip.version')).toEqual([1]);
    expect(bytesOf(dissection, 'rip.1.family')).toEqual([0, 2]);
    expect(bytesOf(dissection, 'rip.1.mask')).toEqual([0, 0, 0, 0]);
    expect(bytesOf(dissection, 'rip.1.nextHop')).toEqual([0, 0, 0, 0]);
    expect(field(dissection, 'rip.1.mask')!.value).toBe('0.0.0.0 (none)');
    expect(field(dissection, 'rip.1.mask')!.explain).toMatch(/no room for a mask/);
    expect(field(dissection, 'ipv4.dst')!.value).toBe('255.255.255.255');
  });

  it('reads a request as one entry of family 0 and metric 16', () => {
    const dissection = dissect(ripV2Request);
    const { bytes } = dissection;
    expect(dissection.layers.at(-1)!.summary).toBe('Request for the whole table');
    expect([...bytes.slice(UDP_START + 4, UDP_START + 6)]).toEqual([0, 8 + 4 + ENTRY]);
    expect([...bytes.slice(RIP_START, RIP_START + 4 + ENTRY)]).toEqual([
      ...[1, 2, 0, 0],
      ...new Array<number>(16).fill(0),
      ...[0, 0, 0, 16],
    ]);
    expect(field(dissection, 'rip.command')!.value).toBe('1 (request)');
    expect(field(dissection, 'rip.1.family')!.value).toBe('0 (whole table)');
  });
});

/** Where OSPF starts in an untagged Ethernet frame: after 14 bytes of Ethernet and 20 of IPv4. */
const OSPF_START = 34;

/** The OSPF packet's bytes, by the length its header gives. */
function ospfBytesOf({ bytes }: Dissection) {
  const length = (bytes[OSPF_START + 2]! << 8) | bytes[OSPF_START + 3]!;
  return [...bytes.slice(OSPF_START, OSPF_START + length)];
}

/** The common header: version 2, the type, the length, router ID and area, then no auth. */
const header = (type: number, length: number, routerId: number[]) => [
  2,
  type,
  length >> 8,
  length & 0xff,
  ...routerId,
  ...[0, 0, 0, 0],
];
const NO_AUTH = new Array<number>(10).fill(0);

/** True when the Fletcher checksum (ISO 8473) of an LSA, all but its age, comes out to zero. */
function fletcherValid(lsa: readonly number[]) {
  let c0 = 0;
  let c1 = 0;
  for (const byte of lsa.slice(2)) {
    c0 = (c0 + byte) % 255;
    c1 = (c1 + c0) % 255;
  }
  return c0 === 0 && c1 === 0;
}

describe('dissect an OSPF packet', () => {
  const hello = dissect(FRAMES['OSPF hello']!);

  it('stacks OSPFv2 at layer 3 over IPv4 protocol 89', () => {
    expect(hello.layers.map((layer) => [layer.name, layer.osi])).toEqual([
      ['Ethernet II', 2],
      ['IPv4', 3],
      ['OSPFv2', 3],
    ]);
    expect(field(hello, 'ipv4.protocol')!.value).toBe('89 (OSPF)');
    expect(bytesOf(hello, 'ipv4.protocol')).toEqual([89]);
    expect(hello.layers.at(-1)!.summary).toBe('Hello from 1.1.1.1');
  });

  it('writes a checksum over the whole OSPF packet', () => {
    for (const name of ['OSPF hello', 'OSPF LS request', 'OSPF LS update', 'OSPF LS ack']) {
      const ospf = ospfBytesOf(dissect(FRAMES[name]!));
      expect(ospf.slice(12, 14)).not.toEqual([0, 0]);
      expect(internetChecksum(ospf)).toBe(0);
    }
  });

  it('lays out a hello: mask, intervals, options, priority, DR, BDR and each neighbour', () => {
    const ospf = ospfBytesOf(hello);
    expect(ospf.slice(0, 12)).toEqual(header(1, 52, [1, 1, 1, 1]));
    expect(ospf.slice(14, 24)).toEqual(NO_AUTH);
    expect(ospf.slice(24)).toEqual([
      ...[255, 255, 255, 0],
      ...[0, 10],
      0x02,
      1,
      ...[0, 0, 0, 40],
      ...[10, 0, 12, 1],
      ...[10, 0, 12, 2],
      ...[2, 2, 2, 2],
      ...[3, 3, 3, 3],
    ]);
    expect(field(hello, 'ospf.type')!.value).toBe('1 (Hello)');
    expect(field(hello, 'ospf.area')!.value).toBe('0.0.0.0 (area 0)');
    expect(field(hello, 'ospf.mask')!.value).toBe('255.255.255.0 (/24)');
    expect(field(hello, 'ospf.deadInterval')!.value).toBe('40 s');
    expect(field(hello, 'ospf.neighbor.2')!.value).toBe('3.3.3.3');
    expect(field(hello, 'ospf.dr')!.explain).toMatch(/DR/);
  });

  it('lays out a DBD: MTU, flags, sequence and each LSA header', () => {
    const dbd = dissect(FRAMES['OSPF DBD']!);
    // A flag byte and HDLC's 4-byte header, then 20 bytes of IPv4.
    const ospf = [...dbd.bytes.slice(25, 25 + 72)];
    expect(ospf.slice(0, 12)).toEqual(header(2, 72, [2, 2, 2, 2]));
    expect(internetChecksum(ospf)).toBe(0);
    expect(ospf.slice(24, 32)).toEqual([0x05, 0xdc, 0x02, 0x03, 0, 0, 0x10, 0x92]);
    expect(ospf.slice(32, 52)).toEqual([
      ...[0, 1, 0x02, 1],
      ...[1, 1, 1, 1],
      ...[1, 1, 1, 1],
      ...[0x80, 0, 0, 1],
      ...[0, 0, 0, 0],
    ]);
    expect(ospf.slice(52, 56)).toEqual([0x0e, 0x10, 0x02, 2]);
    expect(field(dbd, 'ospf.flags')!.value).toBe('0x03 (More, Master)');
    expect(field(dbd, 'ospf.lsa.1')!.value).toBe(
      'Router LSA 1.1.1.1 from 1.1.1.1, seq 0x80000001, age 1 s',
    );
    expect(field(dbd, 'ospf.lsa.2')!.explain).toMatch(/MaxAge/);
  });

  it('lays out a request as type, link state ID and advertising router', () => {
    const lsr = dissect(FRAMES['OSPF LS request']!);
    const ospf = ospfBytesOf(lsr);
    expect(ospf.slice(0, 12)).toEqual(header(3, 48, [1, 1, 1, 1]));
    expect(ospf.slice(24)).toEqual([
      ...[0, 0, 0, 1, 2, 2, 2, 2, 2, 2, 2, 2],
      ...[0, 0, 0, 2, 10, 0, 12, 2, 2, 2, 2, 2],
    ]);
    expect(field(lsr, 'ospf.request.2')!.value).toBe('Network LSA 10.0.12.2 from 2.2.2.2');
  });

  it('lays out an update with a router LSA and a network LSA, each with its checksum', () => {
    const lsu = dissect(FRAMES['OSPF LS update']!);
    const ospf = ospfBytesOf(lsu);
    expect(ospf.slice(0, 12)).toEqual(header(4, 120, [1, 1, 1, 1]));
    expect(ospf.slice(24, 28)).toEqual([0, 0, 0, 2]);
    const router = ospf.slice(28, 88);
    const network = ospf.slice(88, 120);

    expect(router.slice(0, 16)).toEqual([0, 1, 0x02, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0x80, 0, 0, 1]);
    expect(router.slice(18, 20)).toEqual([0, 60]);
    expect(router.slice(20)).toEqual([
      ...[0, 0, 0, 3],
      ...[10, 0, 12, 1, 10, 0, 12, 1, 2, 0, 0, 1],
      ...[3, 3, 3, 3, 10, 0, 13, 1, 1, 0, 0, 64],
      ...[10, 0, 13, 0, 255, 255, 255, 252, 3, 0, 0, 64],
    ]);
    expect(network.slice(0, 16)).toEqual([
      ...[0x0e, 0x10, 0x02, 2],
      ...[10, 0, 12, 1],
      ...[1, 1, 1, 1],
      ...[0x80, 0, 0, 2],
    ]);
    expect(network.slice(18)).toEqual([0, 32, 255, 255, 255, 0, 1, 1, 1, 1, 2, 2, 2, 2]);
    for (const lsa of [router, network]) {
      expect(lsa.slice(16, 18)).not.toEqual([0, 0]);
      expect(fletcherValid(lsa)).toBe(true);
    }
    expect(internetChecksum(ospf)).toBe(0);

    const checksum = (lsa: number[]) =>
      `0x${((lsa[16]! << 8) | lsa[17]!).toString(16).toUpperCase().padStart(4, '0')}`;
    expect(field(lsu, 'ospf.lsa.1.header')!.value).toBe(
      `Router LSA 1.1.1.1 from 1.1.1.1, seq 0x80000001, age 1 s, checksum ${checksum(router)}, 60 bytes`,
    );
    expect(field(lsu, 'ospf.lsa.1.links')!.value).toBe('3 links');
    expect(field(lsu, 'ospf.lsa.1.link.1')!.value).toBe(
      'Transit network with DR 10.0.12.1, via 10.0.12.1, cost 1',
    );
    expect(field(lsu, 'ospf.lsa.1.link.2')!.value).toBe(
      'Point-to-point to 3.3.3.3 via 10.0.13.1, cost 64',
    );
    expect(field(lsu, 'ospf.lsa.1.link.3')!.value).toBe('Stub 10.0.13.0/30, cost 64');
    expect(field(lsu, 'ospf.lsa.2.mask')!.value).toBe('255.255.255.0 (/24)');
    expect(field(lsu, 'ospf.lsa.2.router.2')!.value).toBe('2.2.2.2');
    expect(field(lsu, 'ospf.lsa.2.header')!.explain).toMatch(/MaxAge/);
    expect(lsu.layers.at(-1)!.summary).toBe('Link state update, 2 LSAs');
  });

  it('lays out an ack as the headers of the LSAs it acknowledges', () => {
    const ack = dissect(FRAMES['OSPF LS ack']!);
    const ospf = ospfBytesOf(ack);
    expect(ospf.slice(0, 12)).toEqual(header(5, 44, [2, 2, 2, 2]));
    expect(ospf.slice(24, 40)).toEqual([0, 1, 0x02, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0x80, 0, 0, 1]);
    expect(field(ack, 'ospf.type')!.value).toBe('5 (Link State Acknowledgment)');
  });

  it('names the OSPF groups in the MAC and IPv4 destinations', () => {
    expect(field(hello, 'ethernet.dst')!.explain).toMatch(/224\.0\.0\.5, all OSPF routers/);
    expect(field(hello, 'ipv4.dst')!.explain).toMatch(/every OSPF router/);
    const update = dissect(FRAMES['OSPF LS update']!);
    expect(field(update, 'ethernet.dst')!.value).toBe('01:00:5e:00:00:06');
    expect(field(update, 'ethernet.dst')!.explain).toMatch(/DR and BDR only/);
    expect(field(update, 'ipv4.dst')!.explain).toMatch(/only the DR and BDR/);
  });
});
