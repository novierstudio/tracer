import { describe, expect, it } from 'vitest';
import type { EventId } from '@/engine/events';
import { describeFrame, protocolOf, visibleFrames } from './protocols';
import { currentFrames, receiveBatch, simulationStore, type SimulationState } from './store';
import { arpRequest, batch, echoRequest, hop } from './testing';

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
});
