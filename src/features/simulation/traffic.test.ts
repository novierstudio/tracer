import { describe, expect, it } from 'vitest';
import { ms } from '@/engine/core/time';
import { createEngine } from '@/engine/engine';
import type { FrameEvent } from '@/engine/events';
import { BROADCAST_MAC, type ConfigBpdu, type EthernetFrame } from '@/engine/pdu';
import { createSimService } from '@/engine/service';
import { STACKS } from '@/engine/stacks';
import { ip, routedLab, STP_CONVERGED } from '@/engine/testing';
import type { DeviceId, MacAddress, Topology } from '@/model';
import { decide, dropLabel } from './pdu/decision';
import { arpRequest, hop } from './testing';
import { CHIP_CAP, createTraffic, DROP_LINGER_MS, RING_MS, travelMs } from './traffic';

const starts = (traffic: ReturnType<typeof createTraffic>, at: number) =>
  traffic.frame(at).chips.map(({ chip }) => [chip.event.id, chip.start]);

/** `hop`, sent to every device on the segment. */
const broadcast = (fields: Parameters<typeof hop>[0]) =>
  sentTo(BROADCAST_MAC, hop({ payload: arpRequest, ...fields }));

function sentTo(dst: string, event: FrameEvent): FrameEvent {
  return { ...event, frame: { ...(event.frame as EthernetFrame), dst: dst as MacAddress } };
}

const bpdu: ConfigBpdu = {
  kind: 'bpdu',
  type: 'config',
  root: { priority: 32768, mac: '02:00:00:00:00:21' as MacAddress } as ConfigBpdu['root'],
  rootPathCost: 0,
  bridge: { priority: 32768, mac: '02:00:00:00:00:21' as MacAddress } as ConfigBpdu['root'],
  port: { priority: 128, number: 1 } as ConfigBpdu['port'],
  messageAge: 0,
  maxAge: 20,
  helloTime: 2,
  forwardDelay: 15,
  topologyChange: false,
  topologyChangeAck: false,
};

describe('travelMs', () => {
  it('stretches a 1 ms link to 300 ms on screen, within 180 to 1200 ms', () => {
    expect(travelMs({ sentAt: 0 as never, time: 1 as never })).toBe(300);
    expect(travelMs({ sentAt: 0 as never, time: 0.1 as never })).toBe(180);
    expect(travelMs({ sentAt: 0 as never, time: 0 as never })).toBe(180);
    expect(travelMs({ sentAt: 0 as never, time: 2 as never })).toBe(600);
    expect(travelMs({ sentAt: 0 as never, time: 50 as never })).toBe(1200);
  });
});

describe('realtime traffic', () => {
  it('plays a packet hop by hop: each hop starts when the hop before it lands', () => {
    const traffic = createTraffic();
    traffic.addRealtime(
      [
        hop({ id: 1, from: 'PC1', to: 'SW1', sentAt: 0 }),
        hop({ id: 2, from: 'SW1', to: 'R1', sentAt: 1 }),
        hop({ id: 3, from: 'R1', to: 'SW2', sentAt: 2 }),
      ],
      1000,
    );

    expect(starts(traffic, 1000)).toEqual([[1, 1000]]);
    expect(starts(traffic, 1300)).toEqual([[2, 1300]]);
    expect(starts(traffic, 1650)).toEqual([[3, 1600]]);
    expect(traffic.frame(1900).chips).toEqual([]);
    expect(traffic.animating(1900)).toBe(false);
  });

  it('chains a hop that arrives in a later batch onto the chip still on screen', () => {
    const traffic = createTraffic();
    traffic.addRealtime([hop({ id: 1, from: 'PC1', to: 'SW1', sentAt: 0 })], 1000);
    traffic.addRealtime([hop({ id: 2, from: 'SW1', to: 'R1', sentAt: 1 })], 1016);
    expect(starts(traffic, 1300)).toEqual([[2, 1300]]);
  });

  it('starts an unrelated frame at once, and fans a broadcast out from where it landed', () => {
    const traffic = createTraffic();
    traffic.addRealtime(
      [
        hop({ id: 1, from: 'PC1', to: 'SW1', sentAt: 0, payload: arpRequest }),
        hop({ id: 2, from: 'PC3', to: 'SW2', sentAt: 0 }),
        hop({ id: 3, from: 'SW1', to: 'R1', sentAt: 1, payload: arpRequest }),
        hop({ id: 4, from: 'SW1', to: 'PC2', sentAt: 1, payload: arpRequest }),
      ],
      0,
    );

    expect(starts(traffic, 0)).toEqual([
      [1, 0],
      [2, 0],
    ]);
    expect(starts(traffic, 300)).toEqual([
      [3, 300],
      [4, 300],
    ]);
  });

  it(`shows at most ${CHIP_CAP} chips at once, dropping the oldest`, () => {
    const traffic = createTraffic();
    const frames = Array.from({ length: 300 }, (_, n) =>
      hop({ id: n + 1, from: `PC${n}`, to: 'SW1', sentAt: 0 }),
    );
    traffic.addRealtime(frames.slice(0, 100), 0);
    traffic.addRealtime(frames.slice(100), 10);

    const shown = traffic.frame(20).chips;
    expect(shown).toHaveLength(CHIP_CAP);
    expect(shown[0]!.chip.event.id).toBe(101);
    // Dropped for good: they do not come back once others finish.
    expect(traffic.frame(305).chips).toHaveLength(CHIP_CAP);
  });
});

describe('easing', () => {
  const sample = (along: (at: number) => number, from: number, to: number) =>
    Array.from({ length: 101 }, (_, n) => along(from + ((to - from) * n) / 100));
  const increasing = (values: number[]) => values.every((v, n) => n === 0 || v >= values[n - 1]!);

  it('carries a realtime chip from 0 to 1 without turning back, and crosses half way at mid-time', () => {
    const traffic = createTraffic();
    traffic.addRealtime([hop({ id: 1, from: 'PC1', to: 'SW1', sentAt: 0 })], 0);
    const along = (at: number) => traffic.frame(at).chips[0]?.along ?? NaN;

    expect(along(0)).toBe(0);
    expect(along(150)).toBeCloseTo(0.5);
    expect(along(299.99)).toBeCloseTo(1, 3);
    expect(increasing(sample(along, 0, 299.99))).toBe(true);
    expect(traffic.frame(300).chips).toEqual([]);
  });

  it('keeps a packet moving through a device: a hop leaves about as fast as the last one landed', () => {
    const traffic = createTraffic();
    traffic.addRealtime(
      [
        hop({ id: 1, from: 'PC1', to: 'SW1', sentAt: 0 }),
        hop({ id: 2, from: 'SW1', to: 'R1', sentAt: 1 }),
      ],
      0,
    );
    const along = (at: number) => traffic.frame(at).chips[0]!.along;
    const landing = (along(299.9) - along(297.9)) / 2;
    const leaving = (along(302) - along(300)) / 2;
    const mean = 1 / 300;

    expect(landing).toBeGreaterThan(mean * 0.4);
    expect(leaving).toBeGreaterThan(mean * 0.4);
    expect(leaving / landing).toBeCloseTo(1, 1);
  });

  it('starts and stops a step’s slide at rest, without turning back', () => {
    const traffic = createTraffic();
    traffic.showMoment(
      { arriving: [hop({ id: 5, from: 'SW1', to: 'R1', sentAt: 4 })], resting: [], leaving: [] },
      0,
      400,
    );
    const along = (at: number) => traffic.frame(at).chips[0]!.along;
    const mean = 1 / 400;

    expect(along(0)).toBe(0);
    expect(along(400)).toBe(1);
    expect(increasing(sample(along, 0, 400))).toBe(true);
    expect(along(2) - along(0)).toBeLessThan(mean * 2 * 0.05);
    expect(along(400) - along(398)).toBeLessThan(mean * 2 * 0.05);
  });
});

describe('a realtime chip’s entrance and exit', () => {
  it('grows and fades in where its packet sets off, and out where it ends', () => {
    const traffic = createTraffic();
    traffic.addRealtime([hop({ id: 1, from: 'PC1', to: 'SW1', sentAt: 0 })], 0);
    const look = (at: number) => {
      const { scale, alpha } = traffic.frame(at).chips[0]!;
      return { scale, alpha };
    };

    expect(look(0).alpha).toBe(0);
    expect(look(0).scale).toBeLessThan(1);
    expect(look(150)).toEqual({ scale: 1, alpha: 1 });
    expect(look(299).alpha).toBeLessThan(0.1);
  });

  it('stays solid where its packet goes on to the next hop', () => {
    const traffic = createTraffic();
    traffic.addRealtime(
      [
        hop({ id: 1, from: 'PC1', to: 'SW1', sentAt: 0 }),
        hop({ id: 2, from: 'SW1', to: 'R1', sentAt: 1 }),
      ],
      0,
    );
    expect(traffic.frame(299).chips[0]).toMatchObject({ alpha: 1, scale: 1 });
    expect(traffic.frame(300).chips[0]).toMatchObject({ alpha: 1, scale: 1 });
  });
});

describe('fan-out rings', () => {
  const rings = (traffic: ReturnType<typeof createTraffic>, at: number) =>
    traffic.frame(at).rings.map(({ device }) => device);

  it('ring the device that floods a broadcast, as its copies leave it', () => {
    const traffic = createTraffic();
    traffic.addRealtime(
      [
        broadcast({ id: 1, from: 'PC1', to: 'SW1', sentAt: 0 }),
        broadcast({ id: 2, from: 'SW1', to: 'R1', sentAt: 1 }),
        broadcast({ id: 3, from: 'SW1', to: 'PC2', sentAt: 1 }),
      ],
      0,
    );

    expect(rings(traffic, 0)).toEqual(['PC1']);
    expect(rings(traffic, 299)).toEqual(['PC1']);
    expect(rings(traffic, 300)).toEqual(['PC1', 'SW1']);
    const ringAt = (at: number) => traffic.frame(at).rings.find(({ device }) => device === 'SW1')!;
    const early = ringAt(320);
    const late = ringAt(800);
    expect(late.spread).toBeGreaterThan(early.spread);
    expect(late.alpha).toBeLessThan(early.alpha);
    expect(rings(traffic, 300 + RING_MS)).toEqual([]);
  });

  it('ring a switch flooding a unicast frame it has no address for, out several ports', () => {
    const traffic = createTraffic();
    traffic.addRealtime(
      [
        hop({ id: 1, from: 'SW1', to: 'R1', sentAt: 0 }),
        hop({ id: 2, from: 'SW1', to: 'PC2', sentAt: 0 }),
      ],
      0,
    );
    expect(rings(traffic, 10)).toEqual(['SW1']);
  });

  it('leave alone one unicast frame, frames to different places, and spanning-tree hellos', () => {
    const traffic = createTraffic();
    const hello = (id: number, to: string) => {
      const event = hop({ id, from: 'SW1', to, sentAt: 0 });
      return {
        ...event,
        frame: {
          ...(event.frame as EthernetFrame),
          dst: '01:80:c2:00:00:00' as MacAddress,
          payload: bpdu,
        },
      };
    };
    const elsewhere = hop({ id: 3, from: 'R1', to: 'SW2', sentAt: 0 });
    traffic.addRealtime(
      [
        hop({ id: 1, from: 'PC1', to: 'SW1', sentAt: 0 }),
        hello(4, 'SW2'),
        hello(5, 'SW3'),
        hop({ id: 2, from: 'R1', to: 'SW1', sentAt: 0, payload: arpRequest }),
        sentTo('02:00:00:00:00:09', elsewhere),
      ],
      0,
    );
    expect(rings(traffic, 10)).toEqual([]);
  });

  it('ring the flooding device when a step brings its copies', () => {
    const traffic = createTraffic();
    traffic.showMoment(
      {
        arriving: [
          broadcast({ id: 2, from: 'SW1', to: 'R1', sentAt: 1 }),
          broadcast({ id: 3, from: 'SW1', to: 'PC2', sentAt: 1 }),
        ],
        resting: [],
        leaving: [],
      },
      0,
      400,
    );
    expect(rings(traffic, 0)).toEqual(['SW1']);
  });
});

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
  return engine.log
    .since(mark)
    .filter((event): event is FrameEvent => event.kind === 'frame')
    .filter(({ frame }) => frame.kind !== 'ethernet' || frame.payload.kind !== 'bpdu');
}

const dropsIn = (topology: Topology) => (event: FrameEvent) =>
  dropLabel(decide(event, topology.devices[event.to.device]));

/** The echo request PC1 sends R1 for an address R1 has no route to, and R1's topology. */
function echoToNowhere() {
  const { lab, pc1 } = routedLab();
  const { topology } = lab;
  const event = pingFrames(topology, pc1, '10.9.9.9').find(
    ({ frame, to }) =>
      frame.kind === 'ethernet' &&
      frame.payload.kind === 'ipv4' &&
      topology.devices[to.device]!.kind === 'router',
  )!;
  return { event, traffic: createTraffic({ drop: dropsIn(topology) }) };
}

describe('dropped frames', () => {
  it('name why the router dropped a ping it has no route for, and no other hop', () => {
    const { lab, pc1 } = routedLab();
    const { topology } = lab;
    const traffic = createTraffic({ drop: dropsIn(topology) });
    traffic.showMoment(
      { arriving: [], resting: pingFrames(topology, pc1, '10.9.9.9'), leaving: [] },
      0,
      400,
    );

    const drops = traffic
      .frame(0)
      .chips.map(({ chip }) => [
        topology.devices[chip.event.to.device]!.config.hostname,
        chip.drop,
      ]);
    expect(drops.filter(([, drop]) => drop !== undefined)).toEqual([['R1', 'No route']]);
  });

  it('turn into a cross at the receiving end once the chip lands, which pops and then goes', () => {
    const { event, traffic } = echoToNowhere();
    traffic.addRealtime([event], 0);
    const end = travelMs(event);

    expect(traffic.frame(end / 2).chips[0]).toMatchObject({ dropped: false, moving: true });
    const popping = traffic.frame(end + 120).chips[0]!;
    expect(popping).toMatchObject({ dropped: true, along: 1, moving: false });
    expect(popping.scale).toBeGreaterThan(1);
    expect(traffic.frame(end + 1000).chips[0]).toMatchObject({ dropped: true, scale: 1, alpha: 1 });
    expect(traffic.frame(end + DROP_LINGER_MS).chips).toEqual([]);
  });

  it('mark a frame lost to a link that is down near its sending end, from the start', () => {
    const traffic = createTraffic();
    traffic.addRealtime(
      [{ ...hop({ id: 1, from: 'PC1', to: 'SW1', sentAt: 0 }), outcome: 'link-down' }],
      0,
    );
    expect(traffic.frame(50).chips[0]).toMatchObject({
      chip: { drop: 'Link down' },
      dropped: true,
      along: 0,
    });
  });
});

describe('a moment in Simulation mode', () => {
  it('slides arriving packets across and keeps them where they landed', () => {
    const traffic = createTraffic();
    traffic.showMoment(
      { arriving: [hop({ id: 5, from: 'SW1', to: 'R1', sentAt: 4 })], resting: [], leaving: [] },
      0,
      400,
    );
    expect(traffic.frame(200).chips[0]).toMatchObject({ along: expect.closeTo(0.5), moving: true });
    expect(traffic.frame(5000).chips[0]).toMatchObject({ along: 1, moving: false });
  });

  it('slides undone packets back to where they came from, then drops them', () => {
    const traffic = createTraffic();
    const resting = hop({ id: 4, from: 'PC1', to: 'SW1', sentAt: 3 });
    traffic.showMoment(
      {
        arriving: [],
        resting: [resting],
        leaving: [hop({ id: 5, from: 'SW1', to: 'R1', sentAt: 4 })],
      },
      0,
      400,
    );
    const at300 = traffic
      .frame(300)
      .chips.map(({ chip, along }) => [chip.event.id, chip.motion, along]);
    expect(at300).toEqual([
      [5, 'return', expect.any(Number)],
      [4, 'rest', 1],
    ]);
    expect(at300[0]![2]).toBeGreaterThan(0);
    expect(at300[0]![2]).toBeLessThan(0.5);
    expect(traffic.frame(400).chips.map(({ chip }) => chip.event.id)).toEqual([4]);
  });
});

describe('reduced motion', () => {
  const still = { reducedMotion: true };

  it('jumps each chip to where it is going, with no trail, fade or growth', () => {
    const traffic = createTraffic();
    traffic.addRealtime([hop({ id: 1, from: 'PC1', to: 'SW1', sentAt: 0 })], 0);
    traffic.addRealtime([hop({ id: 2, from: 'PC3', to: 'SW2', sentAt: 0 })], 100);

    for (const at of [0, 100, 150, 299]) {
      for (const place of traffic.frame(at, still).chips) {
        expect(place).toMatchObject({ along: 1, moving: false, scale: 1, alpha: 1 });
      }
    }
  });

  it('jumps a step back’s packets home at once', () => {
    const traffic = createTraffic();
    traffic.showMoment(
      { arriving: [], resting: [], leaving: [hop({ id: 5, from: 'SW1', to: 'R1', sentAt: 4 })] },
      0,
      400,
    );
    expect(traffic.frame(0, still).chips[0]).toMatchObject({ along: 0, moving: false });
  });

  it('shows a drop’s cross at once and at full size, without a pop', () => {
    const { event, traffic } = echoToNowhere();
    traffic.addRealtime([event], 0);
    const end = travelMs(event);

    for (const at of [0, end + 100, end + DROP_LINGER_MS - 50]) {
      expect(traffic.frame(at, still).chips[0]).toMatchObject({
        dropped: true,
        along: 1,
        scale: 1,
        alpha: 1,
      });
    }
  });

  it('holds a fan-out ring still instead of spreading it', () => {
    const traffic = createTraffic();
    traffic.addRealtime(
      [
        broadcast({ id: 2, from: 'SW1', to: 'R1', sentAt: 1 }),
        broadcast({ id: 3, from: 'SW1', to: 'PC2', sentAt: 1 }),
      ],
      0,
    );
    const early = traffic.frame(10, still).rings;
    const late = traffic.frame(RING_MS - 10, still).rings;
    expect(early).toHaveLength(1);
    expect(late).toEqual(early);
  });
});

describe('animating, which keeps the overlay drawing', () => {
  /** Draws `at`, as the overlay does, then asks whether the next frame would differ. */
  const animatingAt = (
    traffic: ReturnType<typeof createTraffic>,
    at: number,
    reducedMotion = false,
  ) => {
    traffic.frame(at, { reducedMotion });
    return traffic.animating(at, { reducedMotion });
  };

  it('holds while a realtime packet crosses, waits for its next hop or fades, and stops once it is gone', () => {
    const traffic = createTraffic();
    expect(animatingAt(traffic, 0)).toBe(false);
    traffic.addRealtime(
      [
        hop({ id: 1, from: 'PC1', to: 'SW1', sentAt: 0 }),
        hop({ id: 2, from: 'SW1', to: 'R1', sentAt: 1 }),
      ],
      1000,
    );
    for (const at of [1000, 1299, 1300, 1599]) expect(animatingAt(traffic, at)).toBe(true);
    expect(animatingAt(traffic, 1600)).toBe(false);
  });

  it('holds while a step’s packets slide in, then stops with them resting where they landed', () => {
    const traffic = createTraffic();
    traffic.showMoment(
      {
        arriving: [hop({ id: 5, from: 'SW1', to: 'R1', sentAt: 4 })],
        resting: [hop({ id: 4, from: 'PC1', to: 'SW1', sentAt: 3 })],
        leaving: [],
      },
      0,
      400,
    );
    expect(animatingAt(traffic, 200)).toBe(true);
    expect(animatingAt(traffic, 400)).toBe(false);
    expect(traffic.frame(60_000).chips).toHaveLength(2);
  });

  it('holds while a step back’s packets slide home, and stops once they have gone', () => {
    const traffic = createTraffic();
    traffic.showMoment(
      { arriving: [], resting: [], leaving: [hop({ id: 5, from: 'SW1', to: 'R1', sentAt: 4 })] },
      0,
      400,
    );
    expect(animatingAt(traffic, 399)).toBe(true);
    expect(animatingAt(traffic, 400)).toBe(false);
  });

  it('holds while a dropped arrival’s cross pops, and stops once it has settled', () => {
    const { event, traffic } = echoToNowhere();
    traffic.showMoment({ arriving: [event], resting: [], leaving: [] }, 0, 400);
    expect(animatingAt(traffic, 400 + 100)).toBe(true);
    expect(animatingAt(traffic, 400 + 1000)).toBe(false);
  });

  it('holds while a fan-out ring spreads, and stops once it has gone', () => {
    const traffic = createTraffic();
    traffic.showMoment(
      {
        arriving: [
          broadcast({ id: 2, from: 'SW1', to: 'R1', sentAt: 1 }),
          broadcast({ id: 3, from: 'SW1', to: 'PC2', sentAt: 1 }),
        ],
        resting: [],
        leaving: [],
      },
      0,
      100,
    );
    expect(animatingAt(traffic, RING_MS - 10)).toBe(true);
    expect(animatingAt(traffic, RING_MS)).toBe(false);
  });

  it('under reduced motion, stops at once for a step, but holds until realtime chips leave', () => {
    const traffic = createTraffic();
    traffic.showMoment(
      { arriving: [hop({ id: 5, from: 'SW1', to: 'R1', sentAt: 4 })], resting: [], leaving: [] },
      0,
      400,
    );
    expect(animatingAt(traffic, 0, true)).toBe(false);

    traffic.addRealtime([hop({ id: 1, from: 'PC1', to: 'SW1', sentAt: 0 })], 1000);
    expect(animatingAt(traffic, 1000, true)).toBe(true);
  });

  it('tells subscribers when chips arrive or are cleared, until they unsubscribe', () => {
    const traffic = createTraffic();
    let calls = 0;
    const stop = traffic.subscribe(() => calls++);
    traffic.addRealtime([hop({ id: 1, from: 'PC1', to: 'SW1', sentAt: 0 })], 0);
    traffic.showMoment({ arriving: [], resting: [], leaving: [] }, 0, 400);
    traffic.clear();
    expect(calls).toBe(3);
    stop();
    traffic.clear();
    expect(calls).toBe(3);
  });
});
