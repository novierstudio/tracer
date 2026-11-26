import type { SimEventBatch } from '@/engine/api';
import { ms, type SimTime } from '@/engine/core/time';
import { createEngine } from '@/engine/engine';
import type { EventId, FrameEvent } from '@/engine/events';
import {
  LIMITED_BROADCAST,
  RIP_GROUP,
  UDP_PORT,
  type ArpPacket,
  type EthernetFrame,
  type Ipv4Packet,
  type RipMessage,
} from '@/engine/pdu';
import { createSimService } from '@/engine/service';
import { STACKS } from '@/engine/stacks';
import { ip as parseIp, STP_CONVERGED } from '@/engine/testing';
import type {
  DeviceId,
  Ipv4Address,
  LinkId,
  MacAddress,
  PortId,
  PrefixLength,
  Topology,
} from '@/model';

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

/** A RIP message in a UDP datagram from 10.0.12.1, to RIPv2's group or, for v1, broadcast. */
export function ripPacket(message: RipMessage): Ipv4Packet {
  return {
    kind: 'ipv4',
    src: ip('10.0.12.1'),
    dst: message.version === 2 ? RIP_GROUP : LIMITED_BROADCAST,
    ttl: message.version === 2 ? 2 : 1,
    id: 4,
    payload: { kind: 'udp', srcPort: UDP_PORT.rip, dstPort: UDP_PORT.rip, payload: message },
  };
}

const prefix = (length: number) => length as PrefixLength;

/** Three routes: one a hop away, one two hops, and one poisoned. */
export const ripV2Response: RipMessage = {
  kind: 'rip',
  command: 'response',
  version: 2,
  entries: [
    { network: ip('192.168.1.0'), prefixLength: prefix(24), metric: 1 },
    { network: ip('10.0.23.0'), prefixLength: prefix(30), metric: 2 },
    { network: ip('172.16.0.0'), prefixLength: prefix(16), metric: 16 },
  ],
};

export const ripV1Response: RipMessage = {
  kind: 'rip',
  command: 'response',
  version: 1,
  entries: [{ network: ip('192.168.1.0'), metric: 1 }],
};

export const ripRequest = (version: 1 | 2): RipMessage => ({
  kind: 'rip',
  command: 'request',
  version,
});

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
