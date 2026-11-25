import { describe, expect, it } from 'vitest';
import type { DeviceId, Ipv4Address } from '@/model';
import type { PingEvent, SimAPI, SimEventBatch, TraceEvent } from './api';
import { ms, simTime } from './core/time';
import { createEngine } from './engine';
import type { EventId, FrameEvent, SimEvent } from './events';
import { createHistory } from './history';
import { ipModule } from './l3/ip';
import { startPing } from './l3/ping';
import { createSimService } from './service';
import { STACKS } from './stacks';
import { ip, routedLab } from './testing';

const PC1_IP = ip('192.168.1.10');
const PC2_IP = ip('192.168.2.10');

/**
 * Spanning tree forwards from 30 s and its roots send a hello every 2 s, so between 31 s and the
 * hello at 32 s the network is quiet but for what a test starts.
 */
const QUIET = simTime(31_000);
const NEXT_HELLO = simTime(32_000);

/** A service on the routed lab, already in Simulation mode, with a manual frame clock. */
function routed() {
  const { lab, ...devices } = routedLab();
  const engine = createEngine({ seed: 1, stacks: STACKS, linkDelay: ms(1) });
  let due: (() => void)[] = [];
  const sim = createSimService({ engine, frames: { now: () => 0, request: (c) => due.push(c) } });
  const batches: SimEventBatch[] = [];
  sim.load(lab.topology);
  engine.runUntil(QUIET);
  sim.subscribe((batch) => batches.push(batch));
  sim.setMode('simulation');
  const frame = () => {
    const callbacks = due;
    due = [];
    for (const callback of callbacks) callback();
    return batches.at(-1)!;
  };
  const names = new Map(
    Object.values(lab.topology.devices).map((device) => [device.id, device.config.hostname]),
  );
  /** Each frame a step logged, as "from > to protocol". */
  const hops = (events: SimEvent[]) =>
    events
      .filter((event): event is FrameEvent => event.kind === 'frame')
      .map(({ from, to, frame }) => {
        const payload = frame.kind === 'ethernet' ? frame.payload.kind : frame.kind;
        return `${names.get(from.device)} > ${names.get(to.device)} ${payload}`;
      });
  /** Every step until spanning tree's next hello, each step's events in order. */
  const stepAll = (): SimEvent[][] => {
    const steps: SimEvent[][] = [];
    for (let next = engine.nextTime(); next !== undefined && next < NEXT_HELLO;) {
      steps.push(sim.step());
      next = engine.nextTime();
    }
    return steps;
  };
  return { sim, frame, hops, stepAll, ...devices };
}

function ping(sim: SimAPI, from: DeviceId, target: Ipv4Address, count = 1) {
  const heard: PingEvent[] = [];
  sim.ping(from, target, { count, timeoutMs: 1000 }, (event) => heard.push(event));
  return heard;
}

describe('stepping in Simulation mode', () => {
  it('moves every packet one hop per step across the router', () => {
    const { sim, hops, stepAll, pc1 } = routed();
    ping(sim, pc1, PC2_IP);

    expect(stepAll().map(hops)).toEqual(
      [
        'PC1 > SW1 arp',
        'SW1 > R1 arp',
        'R1 > SW1 arp',
        'SW1 > PC1 arp',
        'PC1 > SW1 ipv4',
        'SW1 > R1 ipv4',
        'R1 > SW2 arp',
        'SW2 > PC2 arp',
        'PC2 > SW2 arp',
        'SW2 > R1 arp',
        'R1 > SW2 ipv4',
        'SW2 > PC2 ipv4',
        'PC2 > SW2 ipv4',
        'SW2 > R1 ipv4',
        'R1 > SW1 ipv4',
        'SW1 > PC1 ipv4',
      ].map((hop) => [hop]),
    );
  });

  it('steps back hop by hop to where Simulation mode began, and no further', () => {
    const { sim, frame, pc1 } = routed();
    ping(sim, pc1, PC2_IP);
    const start = frame().head;
    const heads = Array.from({ length: 6 }, () => {
      sim.step();
      return frame().head;
    });

    for (const head of [...heads.slice(0, -1).reverse(), start]) {
      expect(sim.stepBack()).toBe(true);
      expect(frame()).toMatchObject({ head, events: [] });
    }
    expect(frame().canStepBack).toBe(false);
    expect(sim.stepBack()).toBe(false);
  });

  it('replays the same events with the same ids, and the ping hears each reply once', () => {
    const { sim, stepAll, pc1 } = routed();
    const heard = ping(sim, pc1, PC2_IP);
    const original = stepAll();

    while (sim.stepBack());
    const replayed = stepAll();

    expect(replayed).toEqual(original);
    expect(heard).toEqual([
      expect.objectContaining({ kind: 'reply', seq: 1 }),
      expect.objectContaining({ kind: 'summary', sent: 1, received: 1 }),
    ]);
  });

  it('leaves the network in the same state after stepping back as stepping there directly', () => {
    const direct = routed();
    ping(direct.sim, direct.pc1, PC2_IP);
    for (let index = 0; index < 8; index++) direct.sim.step();

    const roundTrip = routed();
    ping(roundTrip.sim, roundTrip.pc1, PC2_IP);
    for (let index = 0; index < 14; index++) roundTrip.sim.step();
    for (let index = 0; index < 6; index++) roundTrip.sim.stepBack();

    for (const device of [direct.pc1, direct.r1, direct.pc2]) {
      expect(roundTrip.sim.arpTable(device)).toEqual(direct.sim.arpTable(device));
    }
    expect(roundTrip.sim.macTable(direct.sw2)).toEqual(direct.sim.macTable(direct.sw2));
    expect(roundTrip.stepAll()).toEqual(direct.stepAll());
  });

  it('repeats a ping started mid-history when stepping forward through that moment again', () => {
    const { sim, hops, stepAll, pc1, pc2 } = routed();
    ping(sim, pc1, PC2_IP);
    for (let index = 0; index < 3; index++) sim.step();
    const back = ping(sim, pc2, PC1_IP);
    const original = stepAll();

    for (let index = 0; index < original.length + 2; index++) sim.stepBack();
    sim.step();
    sim.step();
    const replayed = stepAll();

    expect(replayed.slice(-original.length)).toEqual(original);
    expect(original.flatMap(hops)).toContain('PC2 > SW2 arp');
    expect(back.map((event) => event.kind)).toEqual(['reply', 'summary']);
  });

  it('replays a traceroute and a cancelled ping, each heard once', () => {
    const { sim, stepAll, pc1, pc2 } = routed();
    const traced: TraceEvent[] = [];
    const options = { maxHops: 30, probesPerHop: 3, timeoutMs: 1000 };
    sim.traceroute(pc1, PC2_IP, options, (event) => traced.push(event));
    const pinged: PingEvent[] = [];
    const endless = sim.ping(pc2, PC1_IP, { count: Infinity, timeoutMs: 1000 }, (event) =>
      pinged.push(event),
    );
    for (let index = 0; index < 20; index++) sim.step();
    if (endless.ok) sim.cancel(endless.value);
    const original = stepAll();

    while (sim.stepBack());
    const replayed = stepAll();

    expect(replayed.slice(-original.length)).toEqual(original);
    expect(traced.map((event) => (event.kind === 'done' ? 'done' : event.hop))).toEqual([
      1,
      1,
      1,
      2,
      2,
      2,
      'done',
    ]);
    expect(pinged.map((event) => event.kind)).toEqual(['reply', 'summary']);
  });

  it('cuts the future when something new happens after stepping back', () => {
    const { sim, hops, stepAll, pc1, pc2 } = routed();
    ping(sim, pc1, PC2_IP);
    for (let index = 0; index < 4; index++) sim.step();
    const later = ping(sim, pc2, PC1_IP);
    sim.step();
    sim.stepBack();
    sim.stepBack();
    expect(later).toEqual([]);

    // A new ping at this earlier moment: the PC2 ping that came after it never happened.
    ping(sim, pc1, PC2_IP);
    expect(later).toEqual([{ kind: 'summary', target: PC1_IP, sent: 0, received: 0 }]);
    // PC2 still answers, but never asks R1 for its MAC to ping PC1 itself.
    const rest = stepAll().flatMap(hops);
    expect(rest).toContain('PC2 > SW2 ipv4');
    expect(rest.filter((hop) => hop === 'PC2 > SW2 arp')).toHaveLength(1);
  });
});

describe('createHistory', () => {
  const END = simTime(35_000);

  function run(snapshotEvery: number) {
    const { lab, pc1 } = routedLab();
    const engine = createEngine({ seed: 1, stacks: STACKS, linkDelay: ms(1) });
    engine.load(lab.topology);
    engine.runUntil(QUIET);
    const history = createHistory(engine, { snapshotEvery });
    /** Steps the three echoes and the spanning tree hellos among them, to 35 s. */
    const forward = () => (engine.nextTime() ?? Infinity) < END && history.forward();
    history.input({
      apply: () =>
        engine.withModule(pc1, ipModule, (ctx) =>
          startPing(ctx, PC2_IP, { count: 3, timeoutMs: 1000 }, () => {}),
        ),
    });
    const heads: number[] = [];
    while (forward()) heads.push(engine.log.lastId);
    const once = engine.log.since(0 as EventId);

    for (let index = 0; index < heads.length - 3; index++) history.back();
    const backHead = engine.log.lastId;
    while (forward());
    return { heads, backHead, forward: once, again: engine.log.since(0 as EventId) };
  }

  it('gives the same run whether it snapshots every event or almost never', () => {
    const every = run(1);
    const rarely = run(1000);

    expect(every.heads.length).toBeGreaterThan(30);
    expect(every.backHead).toBe(every.heads[2]);
    expect(every.again).toEqual(every.forward);
    expect(rarely).toEqual(every);
  });
});
