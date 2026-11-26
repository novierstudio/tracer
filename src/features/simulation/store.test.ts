import { describe, expect, it } from 'vitest';
import type { EventId } from '@/engine/events';
import { describeFrame, protocolOf, visibleFrames } from './protocols';
import { currentFrames, receiveBatch, simulationStore, type SimulationState } from './store';
import {
  arpRequest,
  batch,
  dnsAnswer,
  dnsNoSuchName,
  dnsQuery,
  echoRequest,
  hop,
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
  webPacket,
  webSession,
} from './testing';

const initial = simulationStore.getInitialState();
const fold = (state: SimulationState, next: ReturnType<typeof batch>) => ({
  ...state,
  ...receiveBatch(state, next),
});
const ids = (state: SimulationState) => state.frames.map((event) => event.id);

const arp = (id: number) => hop({ id, from: 'PC1', to: 'SW1', sentAt: id, payload: arpRequest });
const icmp = (id: number) => hop({ id, from: 'SW1', to: 'R1', sentAt: id, payload: echoRequest });

describe('receiveBatch', () => {
  it('adds the frames of Simulation batches and leaves the list alone in realtime', () => {
    let state = fold(initial, batch({ mode: 'realtime', events: [arp(1)] }));
    expect(ids(state)).toEqual([]);

    state = fold(state, batch({ events: [arp(2), icmp(3)] }));
    state = fold(state, batch({ events: [icmp(4)] }));
    expect(ids(state)).toEqual([2, 3, 4]);
    expect(state).toMatchObject({ head: 4, now: 5, canStepBack: true });
  });

  it('drops the frames a step back undid, and replaces replayed ones by id', () => {
    let state = fold(initial, batch({ events: [arp(1), arp(2), icmp(3), icmp(4)] }));
    state = { ...state, selected: 4 as EventId };

    state = fold(state, batch({ events: [], head: 2 as EventId }));
    expect(ids(state)).toEqual([1, 2]);
    expect(state.selected).toBeUndefined();

    // A step back and a step forward inside one frame: the batch starts at the replayed id.
    state = fold(state, batch({ events: [icmp(3), icmp(4)] }));
    state = fold(state, batch({ events: [icmp(3)], head: 3 as EventId }));
    expect(ids(state)).toEqual([1, 2, 3]);
  });

  it('finds the frames at the current instant: where each packet is now', () => {
    const frames = [arp(1), arp(2), hop({ id: 3, from: 'SW1', to: 'PC2', sentAt: 2 })];
    expect(currentFrames({ frames, now: 3 as never }).map((event) => event.id)).toEqual([2, 3]);
    expect(currentFrames({ frames, now: 9 as never })).toEqual([]);
  });
});

describe('protocol filters', () => {
  it('hides the frames of a hidden protocol and keeps the order of the rest', () => {
    const frames = [arp(1), icmp(2), arp(3), icmp(4)];
    expect(visibleFrames(frames, []).map((event) => event.id)).toEqual([1, 2, 3, 4]);
    expect(visibleFrames(frames, ['arp']).map((event) => event.id)).toEqual([2, 4]);
    expect(visibleFrames(frames, ['arp', 'icmp'])).toEqual([]);
  });

  it('classifies ARP and ICMP, and says what each frame does', () => {
    expect(protocolOf(arp(1).frame)).toBe('arp');
    expect(protocolOf(icmp(1).frame)).toBe('icmp');
    expect(describeFrame(arp(1))).toBe('Who has 192.168.1.1? Tell 192.168.1.10');
    expect(describeFrame(icmp(1))).toBe('Echo request 192.168.1.10 → 192.168.2.10, seq 1, TTL 128');
    expect(describeFrame({ ...icmp(1), outcome: 'link-down' })).toMatch(/^Lost, link down: Echo/);
  });

  it('classifies RIP and says what each RIP message carries', () => {
    const rip = (payload: Parameters<typeof ripPacket>[0]) =>
      hop({ id: 1, from: 'R1', to: 'R2', sentAt: 1, payload: ripPacket(payload) });
    expect(protocolOf(rip(ripV2Response).frame)).toBe('rip');
    expect(describeFrame(rip(ripV2Response))).toBe(
      'RIPv2 response, 3 routes 10.0.12.1 → 224.0.0.9',
    );
    expect(describeFrame(rip(ripV1Response))).toBe(
      'RIPv1 response, 1 route 10.0.12.1 → 255.255.255.255',
    );
    expect(describeFrame(rip(ripRequest(1)))).toBe('RIPv1 request for the whole table');
  });

  it('classifies OSPF and says what each OSPF packet carries', () => {
    const ospf = (payload: Parameters<typeof ospfPacket>[0]) =>
      hop({ id: 1, from: 'R1', to: 'R2', sentAt: 1, payload: ospfPacket(payload) });
    expect(protocolOf(ospf(ospfHello).frame)).toBe('ospf');
    expect(describeFrame(ospf(ospfHello))).toBe('OSPF hello from 1.1.1.1, DR 10.0.12.1');
    expect(describeFrame(ospf({ ...ospfHello, dr: '0.0.0.0' as never }))).toBe(
      'OSPF hello from 1.1.1.1',
    );
    expect(describeFrame(ospf(ospfDbd))).toBe('OSPF DBD from 2.2.2.2, 2 LSA headers (master)');
    expect(describeFrame(ospf({ ...ospfDbd, init: true, master: false, headers: [] }))).toBe(
      'OSPF DBD from 2.2.2.2, 0 LSA headers (init, slave)',
    );
    expect(describeFrame(ospf(ospfLsr))).toBe('OSPF LS request, 2 LSAs');
    expect(describeFrame(ospf(ospfLsu))).toBe('OSPF LS update from 1.1.1.1, 2 LSAs');
    expect(describeFrame(ospf(ospfAck))).toBe('OSPF LS ack, 1 LSA');
  });

  it('classifies a segment that carries HTTP as HTTP, and a bare one as TCP', () => {
    const web = (payload: Parameters<typeof webPacket>[0]) =>
      hop({ id: 1, from: 'PC1', to: 'SW1', sentAt: 1, payload: webPacket(payload) });
    expect(webSession.map((segment) => protocolOf(web(segment).frame))).toEqual([
      'tcp',
      'tcp',
      'tcp',
      'http',
      'http',
      'tcp',
      'tcp',
      'tcp',
      'tcp',
    ]);
    // The GET is 58 bytes and the response 142, so the sequence numbers jump by those.
    expect(webSession.map((segment) => describeFrame(web(segment)))).toEqual([
      'TCP 49152 → 80 [SYN] Seq=4000000000',
      'TCP 80 → 49152 [SYN, ACK] Seq=123456 Ack=4000000001',
      'TCP 49152 → 80 [ACK] Seq=4000000001 Ack=123457',
      'HTTP GET / (Host www.lab.local)',
      'HTTP 200 OK, text/html, 59 bytes',
      'TCP 80 → 49152 [FIN, ACK] Seq=123599 Ack=4000000059',
      'TCP 49152 → 80 [ACK] Seq=4000000059 Ack=123599',
      'TCP 49152 → 80 [FIN, ACK] Seq=4000000059 Ack=123600',
      'TCP 80 → 49152 [ACK] Seq=123600 Ack=4000000060',
    ]);
  });

  it('classifies DNS and says what was asked and what came back', () => {
    const dns = (payload: Parameters<typeof webPacket>[0]) =>
      hop({ id: 1, from: 'PC1', to: 'SW1', sentAt: 1, payload: webPacket(payload) });
    expect(protocolOf(dns(dnsQuery).frame)).toBe('dns');
    expect(describeFrame(dns(dnsQuery))).toBe('DNS query A www.lab.local');
    expect(describeFrame(dns(dnsAnswer))).toBe('DNS response www.lab.local A 192.168.2.10');
    expect(describeFrame(dns(dnsNoSuchName))).toBe('DNS response: no such name www.x.local');
    expect(describeFrame(dns({ ...dnsAnswer, answers: [] }))).toBe(
      'DNS response www.lab.local: no A record',
    );
  });
});
