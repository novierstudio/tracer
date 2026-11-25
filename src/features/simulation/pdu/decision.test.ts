import { describe, expect, it } from 'vitest';
import { ms } from '@/engine/core/time';
import { createEngine } from '@/engine/engine';
import type { EventId, FrameEvent } from '@/engine/events';
import type { EthernetFrame, Ipv4Packet } from '@/engine/pdu';
import { createSimService } from '@/engine/service';
import { STACKS } from '@/engine/stacks';
import { access, ip, labBuilder, routedLab, STP_CONVERGED, trunk } from '@/engine/testing';
import { PortId, type Device, type DeviceId, type MacAddress, type Topology } from '@/model';
import { decide, describeDecision, dropLabel } from './decision';

/** Every frame of one ping from `from` to `target`, as the engine logs it. */
function pingFrames(topology: Topology, from: DeviceId, target: string): FrameEvent[] {
  const engine = createEngine({ seed: 1, stacks: STACKS, linkDelay: ms(1) });
  const sim = createSimService({ engine, frames: { now: () => 0, request: () => {} } });
  sim.load(topology);
  engine.runUntil(STP_CONVERGED);
  const mark = engine.log.lastId;
  let done = false;
  const started = sim.ping(from, ip(target), { count: 1, timeoutMs: 1000 }, (event) => {
    if (event.kind === 'summary') done = true;
  });
  if (!started.ok) throw new Error(started.error);
  while (!done && engine.nextTime() !== undefined) engine.step();
  return engine.log.since(mark).filter((event) => event.kind === 'frame');
}

const isBpdu = ({ frame }: FrameEvent) =>
  frame.kind === 'ethernet' && frame.payload.kind === 'bpdu';

function sentences(topology: Topology, frames: FrameEvent[]) {
  return frames.map((event) => {
    const device = topology.devices[event.to.device];
    const decision = decide(event, device);
    return decision && describeDecision(decision, device!.config.hostname);
  });
}

const macOf = (device: Device, port: string) => {
  const found = device.ports.find((candidate) => candidate.id === port);
  return found && found.kind !== 'serial' ? found.mac : undefined;
};

describe('the decision sentence', () => {
  it('tells each hop of a ping across a router', () => {
    const { lab, pc1, pc2, r1 } = routedLab();
    const { topology } = lab;
    const r1Inside = macOf(lab.device(r1), 'GigabitEthernet0/0');
    const pc2Mac = macOf(lab.device(pc2), 'FastEthernet0');

    const frames = pingFrames(topology, pc1, '192.168.2.10').filter((event) => !isBpdu(event));
    expect(sentences(topology, frames)).toEqual([
      'SW1 flooded it out 1 port (Gi0/1): a broadcast goes to every port in VLAN 1 except the one it came in on.',
      'R1 owns the address asked for, so it sent an ARP reply with its MAC out Gi0/0.',
      'SW1 switched it out Fa0/1, toward the destination MAC.',
      `PC1 learned that 192.168.1.1 is at ${r1Inside} and sent the waiting packet out Fa0.`,
      'SW1 switched it out Gi0/1, toward the destination MAC.',
      'R1 needs the MAC of next hop 192.168.2.10, so it held the packet and sent an ARP request out Gi0/1.',
      'SW2 flooded it out 1 port (Fa0/1): a broadcast goes to every port in VLAN 1 except the one it came in on.',
      'PC2 owns the address asked for, so it sent an ARP reply with its MAC out Fa0.',
      'SW2 switched it out Gi0/1, toward the destination MAC.',
      `R1 learned that 192.168.2.10 is at ${pc2Mac} and sent the waiting packet out Gi0/1.`,
      'SW2 switched it out Fa0/1, toward the destination MAC.',
      'PC2 is the destination, so it sent an echo reply back out Fa0.',
      'SW2 switched it out Gi0/1, toward the destination MAC.',
      'R1 forwarded it out Gi0/0 and lowered the TTL from 128 to 127.',
      'SW1 switched it out Fa0/1, toward the destination MAC.',
      'The echo reply reached PC1: the ping succeeded.',
    ]);
  });

  it('tells what switches and hosts do with a BPDU', () => {
    const { lab, pc1 } = routedLab();
    const told = sentences(lab.topology, pingFrames(lab.topology, pc1, '192.168.2.10'));
    expect(told).toContain('PC1 ignored it: only switches run spanning tree.');
    expect(told).toContain('R1 ignored it: only switches run spanning tree.');
  });

  it('says why a router dropped a packet it has no route for, and what the sender heard', () => {
    const { lab, pc1 } = routedLab();
    const told = sentences(lab.topology, pingFrames(lab.topology, pc1, '10.9.9.9'));
    expect(told).toContain(
      'R1 has no route to 10.9.9.9, so it dropped the packet and sent Destination Unreachable back out Gi0/0.',
    );
    expect(told.at(-1)).toBe('PC1 heard from 192.168.1.1 that the destination cannot be reached.');
  });

  it('flags drops for the canvas, and leaves forwarding and ignoring alone', () => {
    const { lab, pc1 } = routedLab();
    const frames = pingFrames(lab.topology, pc1, '10.9.9.9');
    const labels = frames.map((event) => dropLabel(decide(event, lab.device(event.to.device))));
    expect(labels.filter(Boolean)).toEqual(['No route']);
    expect(dropLabel({ kind: 'lost' })).toBe('Link down');
  });
});

const mac = (n: number) => `02:00:00:00:00:0${n}` as MacAddress;

function arrival(to: DeviceId, port: string, frame: EthernetFrame, sent: FrameEvent['sent']) {
  return {
    kind: 'frame',
    id: 1 as EventId,
    time: 1,
    sentAt: 0,
    link: 'lnk',
    from: { device: 'dev_x', port: PortId.parse('FastEthernet0') },
    to: { device: to, port: PortId.parse(port) },
    frame,
    outcome: 'delivered',
    sent,
  } as FrameEvent;
}

describe('a decision read from hand-made frames', () => {
  const packet: Ipv4Packet = {
    kind: 'ipv4',
    src: ip('192.168.1.10'),
    dst: ip('192.168.2.10'),
    ttl: 1,
    id: 7,
    payload: { kind: 'icmp', type: 'echo-request', id: 1, seq: 1 },
  };

  it('blames the TTL when a router answers with Time Exceeded', () => {
    const { lab, r1 } = routedLab();
    const router = lab.device(r1);
    const frame: EthernetFrame = {
      kind: 'ethernet',
      src: mac(1),
      dst: macOf(router, 'GigabitEthernet0/0')!,
      payload: packet,
    };
    const timeExceeded: EthernetFrame = {
      kind: 'ethernet',
      src: frame.dst,
      dst: mac(1),
      payload: {
        ...packet,
        src: ip('192.168.1.1'),
        dst: packet.src,
        ttl: 255,
        payload: { kind: 'icmp', type: 'time-exceeded', original: packet },
      },
    };
    const event = arrival(r1, 'GigabitEthernet0/0', frame, [
      { port: PortId.parse('GigabitEthernet0/0'), frame: timeExceeded },
    ]);
    const decision = decide(event, router)!;
    expect(describeDecision(decision, 'R1')).toBe(
      'The TTL ran out at R1, so it dropped the packet and sent Time Exceeded back out Gi0/0.',
    );
    expect(dropLabel(decision)).toBe('TTL expired');
  });

  it('says a switch dropped a tagged frame on an access port, or a VLAN its trunk refuses', () => {
    const lab = labBuilder();
    const sw = lab.switch('SW1', {
      'FastEthernet0/1': access(10),
      'GigabitEthernet0/1': { ...trunk(), allowedVlans: [{ first: 1, last: 5 }] } as never,
    });
    const tagged = (vlan: number): EthernetFrame => ({
      kind: 'ethernet',
      src: mac(1),
      dst: mac(2),
      tag: { vlan: vlan as never },
      payload: packet,
    });
    const onAccess = decide(arrival(sw, 'FastEthernet0/1', tagged(10), []), lab.device(sw))!;
    expect(describeDecision(onAccess, 'SW1')).toBe(
      'SW1 dropped it: a tagged frame arrived on an access port.',
    );
    const onTrunk = decide(arrival(sw, 'GigabitEthernet0/1', tagged(20), []), lab.device(sw))!;
    expect(describeDecision(onTrunk, 'SW1')).toBe(
      'SW1 dropped it: the trunk does not allow VLAN 20.',
    );
    expect(dropLabel(onTrunk)).toBe('VLAN mismatch');
  });

  it('says when a switch tags a frame for a trunk', () => {
    const lab = labBuilder();
    const sw = lab.switch('SW1', { 'FastEthernet0/1': access(10), 'GigabitEthernet0/1': trunk() });
    const frame: EthernetFrame = { kind: 'ethernet', src: mac(1), dst: mac(2), payload: packet };
    const out = { ...frame, tag: { vlan: 10 as never } };
    const event = arrival(sw, 'FastEthernet0/1', frame, [
      { port: PortId.parse('GigabitEthernet0/1'), frame: out },
    ]);
    expect(describeDecision(decide(event, lab.device(sw))!, 'SW1')).toBe(
      'SW1 switched it out trunk Gi0/1 and added an 802.1Q tag for VLAN 10.',
    );
  });

  it('says a host ignored a frame for another MAC', () => {
    const { lab, pc2 } = routedLab();
    const frame: EthernetFrame = { kind: 'ethernet', src: mac(1), dst: mac(9), payload: packet };
    const event = arrival(pc2, 'FastEthernet0', frame, []);
    const decision = decide(event, lab.device(pc2))!;
    expect(describeDecision(decision, 'PC2')).toBe(
      "PC2 ignored it: it is addressed to 02:00:00:00:00:09, not to PC2's MAC.",
    );
    expect(dropLabel(decision)).toBeUndefined();
  });
});
