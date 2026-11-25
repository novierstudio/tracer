import { describe, expect, it } from 'vitest';
import type { FrameEvent } from '@/engine/events';
import { routedLab } from '@/engine/testing';
import { pingFrames } from '../testing';
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
