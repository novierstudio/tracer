import { describe, expect, it } from 'vitest';
import type { Frame } from '@/engine/frame';
import { BROADCAST_MAC, PVST_MAC, UNKNOWN_MAC, type Ipv4Packet } from '@/engine/pdu';
import type { Ipv4Address, MacAddress, VlanId } from '@/model';
import { crc32, dissect, internetChecksum, type Dissection } from './layers';

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
