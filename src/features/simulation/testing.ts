import type { SimEventBatch } from '@/engine/api';
import { ms, type SimTime } from '@/engine/core/time';
import { createEngine } from '@/engine/engine';
import type { EventId, FrameEvent } from '@/engine/events';
import type { ArpPacket, EthernetFrame, Ipv4Packet } from '@/engine/pdu';
import { createSimService } from '@/engine/service';
import { STACKS } from '@/engine/stacks';
import { ip as parseIp, STP_CONVERGED } from '@/engine/testing';
import type { DeviceId, Ipv4Address, LinkId, MacAddress, PortId, Topology } from '@/model';

const mac = (n: number) => `02:00:00:00:00:${n.toString(16).padStart(2, '0')}` as MacAddress;
const ip = (text: string) => text as Ipv4Address;

export const arpRequest: ArpPacket = {
  kind: 'arp',
  op: 'request',
  senderMac: mac(1),
  senderIp: ip('192.168.1.10'),
  targetMac: mac(0),
  targetIp: ip('192.168.1.1'),
};

export const echoRequest: Ipv4Packet = {
  kind: 'ipv4',
  src: ip('192.168.1.10'),
  dst: ip('192.168.2.10'),
  ttl: 128,
  id: 1,
  payload: { kind: 'icmp', type: 'echo-request', id: 1, seq: 1 },
};

type Hop = {
  id: number;
  from: string;
  to: string;
  sentAt: number;
  time?: number;
  payload?: ArpPacket | Ipv4Packet;
};

/** A delivered Ethernet frame on the link between two devices, named by their ids. */
export function hop({ id, from, to, sentAt, time = sentAt + 1, payload = echoRequest }: Hop) {
  const frame: EthernetFrame = { kind: 'ethernet', src: mac(1), dst: mac(2), payload };
  const event: FrameEvent = {
    kind: 'frame',
    id: id as EventId,
    time: time as SimTime,
    sentAt: sentAt as SimTime,
    link: `lnk_${[from, to].sort().join('_')}` as LinkId,
    from: { device: from as DeviceId, port: 'Fa0' as PortId },
    to: { device: to as DeviceId, port: 'Fa0' as PortId },
    frame,
    outcome: 'delivered',
  };
  return event;
}

export function batch(fields: Partial<SimEventBatch> = {}): SimEventBatch {
  const events = fields.events ?? [];
  return {
    now: (events.at(-1)?.time ?? 0) as SimTime,
    mode: 'simulation',
    playing: false,
    events,
    head: (events.at(-1)?.id ?? 0) as EventId,
    canStepBack: true,
    links: {},
    ...fields,
  };
}

/** Every frame of one ping from `from` to `target`, as the engine logs it. */
export function pingFrames(topology: Topology, from: DeviceId, target: string): FrameEvent[] {
  const engine = createEngine({ seed: 1, stacks: STACKS, linkDelay: ms(1) });
  const sim = createSimService({ engine, frames: { now: () => 0, request: () => {} } });
  sim.load(topology);
  engine.runUntil(STP_CONVERGED);
  const mark = engine.log.lastId;
  let done = false;
  const started = sim.ping(from, parseIp(target), { count: 1, timeoutMs: 1000 }, (event) => {
    if (event.kind === 'summary') done = true;
  });
  if (!started.ok) throw new Error(started.error);
  while (!done && engine.nextTime() !== undefined) engine.step();
  return engine.log.since(mark).filter((event) => event.kind === 'frame');
}
