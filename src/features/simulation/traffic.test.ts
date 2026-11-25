import { describe, expect, it } from 'vitest';
import { arpRequest, hop } from './testing';
import { CHIP_CAP, createTraffic, travelMs } from './traffic';

const starts = (traffic: ReturnType<typeof createTraffic>, at: number) =>
  traffic.frame(at).map(({ chip }) => [chip.event.id, chip.start]);

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
    expect(traffic.frame(1900)).toEqual([]);
    expect(traffic.busy).toBe(false);
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

  it('moves a chip from the sending end at its start to the receiving end as it lands', () => {
    const traffic = createTraffic();
    traffic.addRealtime([hop({ id: 1, from: 'PC1', to: 'SW1', sentAt: 0 })], 0);
    const along = (at: number) => traffic.frame(at)[0]?.along;

    expect(along(0)).toBe(0);
    expect(along(150)).toBeCloseTo(0.5);
    expect(along(299)).toBeGreaterThan(0.99);
    expect(along(300)).toBeUndefined();
  });

  it(`shows at most ${CHIP_CAP} chips at once, dropping the oldest`, () => {
    const traffic = createTraffic();
    const frames = Array.from({ length: 300 }, (_, n) =>
      hop({ id: n + 1, from: `PC${n}`, to: 'SW1', sentAt: 0 }),
    );
    traffic.addRealtime(frames.slice(0, 100), 0);
    traffic.addRealtime(frames.slice(100), 10);

    const shown = traffic.frame(20);
    expect(shown).toHaveLength(CHIP_CAP);
    expect(shown[0]!.chip.event.id).toBe(101);
    // Dropped for good: they do not come back once others finish.
    expect(traffic.frame(305)).toHaveLength(CHIP_CAP);
  });

  it('jumps instead of sliding when the user asks for reduced motion', () => {
    const traffic = createTraffic();
    traffic.addRealtime([hop({ id: 1, from: 'PC1', to: 'SW1', sentAt: 0 })], 0);
    expect(traffic.frame(10, { reducedMotion: true })[0]).toMatchObject({ along: 1 });
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
    expect(traffic.frame(200)[0]).toMatchObject({ along: 0.5, moving: true });
    expect(traffic.frame(5000)[0]).toMatchObject({ along: 1, moving: false });
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
    expect(
      traffic.frame(300).map(({ chip, along }) => [chip.event.id, chip.motion, along]),
    ).toEqual([
      [5, 'return', expect.closeTo(0.0625, 3)],
      [4, 'rest', 1],
    ]);
    expect(traffic.frame(400).map(({ chip }) => chip.event.id)).toEqual([4]);
  });
});
