import { describe, expect, it } from 'vitest';
import type { SimTime } from '@/engine/core/time';
import type { EventId, FrameEvent } from '@/engine/events';
import { multicastMac, RIP_GROUP, type EthernetFrame } from '@/engine/pdu';
import { routedLab } from '@/engine/testing';
import { PortId, type LinkId, type MacAddress } from '@/model';
import { pingFrames, ripPacket, ripV2Response } from '../testing';
import { inspect, type PduView } from './inspect';

const value = (view: PduView, id: string) =>
  view.layers.flatMap((layer) => layer.fields).find((field) => field.id === id)?.value;

describe('inspect', () => {
  const { lab, pc1, r1 } = routedLab();
  const frames = pingFrames(lab.topology, pc1, '192.168.2.10');
  const isIcmp = ({ frame }: FrameEvent) =>
    frame.kind === 'ethernet' && frame.payload.kind === 'ipv4';
  // The echo reply on its way back through R1: R1 forwards it without asking ARP.
  const replyAtR1 = frames.filter((event) => isIcmp(event) && event.to.device === r1).at(-1)!;

  it('shows a forwarded packet as it arrived and as it left, with what the router changed', () => {
    const inspection = inspect(replyAtR1, lab.topology);
    expect(inspection.sentence).toBe(
      'R1 forwarded it out Gi0/0 and lowered the TTL from 128 to 127.',
    );
    const [arrived, left] = inspection.views;
    expect(inspection.views.map((view) => view.label)).toEqual(['At R1', 'Out Gi0/0']);
    expect(value(arrived!, 'ipv4.ttl')).toBe('128');
    expect(value(left!, 'ipv4.ttl')).toBe('127');
    expect(left!.changed.get('ipv4.ttl')).toBe('128');
    expect([...left!.changed.keys()]).toEqual(
      expect.arrayContaining(['ethernet.dst', 'ethernet.src', 'ipv4.ttl', 'ipv4.checksum']),
    );
    expect(left!.changed.has('ipv4.src')).toBe(false);
  });

  it('starts each view with the physical layer of the port it is on', () => {
    const [arrived, left] = inspect(replyAtR1, lab.topology).views;
    expect(arrived!.layers[0]!.name).toBe('Physical');
    expect(value(arrived!, 'physical.port')).toBe('R1 GigabitEthernet0/1');
    expect(value(arrived!, 'physical.peer')).toBe('SW2 GigabitEthernet0/1');
    expect(value(arrived!, 'physical.cable')).toBe('Copper straight-through');
    expect(value(left!, 'physical.port')).toBe('R1 GigabitEthernet0/0');
    expect(value(left!, 'physical.peer')).toBe('SW1 GigabitEthernet0/1');
  });

  it('has only the arrived view when the device sent nothing on', () => {
    const last = frames.filter(isIcmp).at(-1)!;
    const inspection = inspect(last, lab.topology);
    expect(inspection.sentence).toBe('The echo reply reached PC1: the ping succeeded.');
    expect(inspection.views.map((view) => view.direction)).toEqual(['in']);
  });
});

describe('inspect a RIP update', () => {
  const { lab, r1, sw2 } = routedLab();
  const router = lab.device(r1);
  if (router.kind !== 'router') throw new Error('R1 is not a router');
  const rip = {
    version: 2 as const,
    networks: [],
    autoSummary: true,
    passiveInterfaces: [],
    defaultOriginate: false,
  };
  const topology = {
    ...lab.topology,
    devices: { ...lab.topology.devices, [r1]: { ...router, config: { ...router.config, rip } } },
  };
  const update = (src: string): EthernetFrame => ({
    kind: 'ethernet',
    src: src as MacAddress,
    dst: multicastMac(RIP_GROUP),
    payload: ripPacket(ripV2Response),
  });
  const event: FrameEvent = {
    kind: 'frame',
    id: 1 as EventId,
    time: 1 as SimTime,
    sentAt: 0 as SimTime,
    link: 'lnk' as LinkId,
    from: { device: sw2, port: PortId.parse('GigabitEthernet0/1') },
    to: { device: r1, port: PortId.parse('GigabitEthernet0/1') },
    frame: update('02:00:00:00:00:21'),
    outcome: 'delivered',
    sent: [{ port: PortId.parse('GigabitEthernet0/0'), frame: update('02:00:00:00:00:31') }],
  };

  it('shows the update down to RIP, and the triggered update R1 sent', () => {
    const inspection = inspect(event, topology);
    expect(inspection.sentence).toBe(
      'R1 read the RIPv2 update and sent a triggered update out Gi0/0.',
    );
    expect(inspection.views.map((view) => view.label)).toEqual(['At R1', 'Out Gi0/0']);
    expect(inspection.views[0]!.layers.map((layer) => layer.name)).toEqual([
      'Physical',
      'Ethernet II',
      'IPv4',
      'UDP',
      'RIPv2',
    ]);
    expect(value(inspection.views[0]!, 'rip.3.metric')).toBe('16 (unreachable)');
  });
});
