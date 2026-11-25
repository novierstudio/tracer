import { describe, expect, it, vi } from 'vitest';
import { addLink, createLink } from '@/model';
import { buildLab, end, expectOk } from '@/model/testing';
import type { SimEventBatch } from './api';
import { ms } from './core/time';
import { createEngine } from './engine';
import { createSimService, type FrameClock } from './service';
import { helloModule, listenerModule, stacksOf } from './testing';

function pcToSwitch() {
  const { ids, topology, pc, sw } = buildLab();
  const link = createLink(
    { cable: 'straight', a: end(pc, 'FastEthernet0'), b: end(sw, 'FastEthernet0/1') },
    { ids, topology },
  );
  return { topology: expectOk(addLink(topology, link)), pc, sw, link };
}

function setup({ period }: { period?: number } = {}) {
  let wall = 0;
  let due: (() => void)[] = [];
  const frames: FrameClock = { now: () => wall, request: (callback) => due.push(callback) };
  const engine = createEngine({
    seed: 1,
    stacks: stacksOf({
      pc: [helloModule({ period: period === undefined ? undefined : ms(period) })],
      switch: [listenerModule],
    }),
    linkDelay: ms(3),
  });
  const sim = createSimService({ engine, frames });
  const batches: SimEventBatch[] = [];
  const lab = pcToSwitch();
  sim.load(lab.topology);
  sim.subscribe((batch) => batches.push(batch));

  const frame = (elapsed = 16) => {
    wall += elapsed;
    const callbacks = due;
    due = [];
    for (const callback of callbacks) callback();
    return batches.length;
  };
  const last = () => batches.at(-1)!;
  return { sim, batches, frame, last, ...lab };
}

const kinds = (batch: SimEventBatch) => batch.events.map((event) => event.kind);

describe('createSimService', () => {
  it('batches what was logged since the last frame, and stays quiet when nothing changed', () => {
    const { sim, batches, frame, link } = setup();
    expect(batches).toEqual([]);

    frame();
    expect(batches).toEqual([
      {
        now: 0,
        mode: 'realtime',
        playing: false,
        events: [expect.objectContaining({ kind: 'link', link: link.id, up: true })],
      },
    ]);

    frame();
    sim.pause();
    frame();
    expect(batches).toHaveLength(1);
  });

  it('plays in realtime at `speed` simulated ms per wall-clock ms', () => {
    const { sim, frame, last, batches } = setup({ period: 10 });
    frame();

    sim.play(2);
    frame(16);
    expect(last()).toMatchObject({ now: 32, playing: true });
    expect(kinds(last())).toEqual(['frame', 'note', 'frame', 'note', 'frame', 'note']);

    frame(5);
    expect(last().now).toBe(42);

    sim.pause();
    frame(16);
    expect(last()).toMatchObject({ now: 42, playing: false, events: [] });
    const count = batches.length;
    frame(1000);
    expect(batches).toHaveLength(count);
  });

  it('catches up at most 100 ms of wall-clock time per frame', () => {
    const { sim, frame, last } = setup();
    sim.play(1);
    frame(60_000);
    expect(last().now).toBe(100);
  });

  it('step pauses and returns the next logged events, which the next batch carries once', () => {
    const { sim, frame, last, pc, sw } = setup({ period: 10 });
    frame();
    sim.play(1);
    frame(1);

    const stepped = sim.step();
    expect(stepped).toMatchObject([
      { kind: 'frame', time: 3, from: end(pc, 'FastEthernet0'), outcome: 'delivered' },
      { kind: 'note', time: 3, device: sw.id },
    ]);

    frame();
    expect(last()).toEqual({ now: 3, mode: 'realtime', playing: false, events: stepped });
    frame(1000);
    expect(last().now).toBe(3);
  });

  it('returns nothing from step when nothing is left to run', () => {
    const { sim, frame } = setup();
    frame();
    expect(sim.step()).toHaveLength(2);
    expect(sim.step()).toEqual([]);
  });

  it('in Simulation mode, plays `speed` logged steps per second', () => {
    const { sim, frame, last } = setup({ period: 10 });
    sim.setMode('simulation');
    frame();
    expect(last()).toMatchObject({ mode: 'simulation', playing: false });

    sim.play(5);
    frame(100);
    expect(last().events).toEqual([]);
    frame(100);
    expect(last()).toMatchObject({ now: 3, playing: true });
    expect(kinds(last())).toEqual(['frame', 'note']);
    frame(100);
    frame(100);
    expect(last().now).toBe(13);
  });

  it('switching mode pauses playback', () => {
    const { sim, frame, last } = setup();
    sim.play(1);
    frame();
    sim.setMode('simulation');
    frame();
    const now = last().now;

    frame(50);
    expect(last()).toMatchObject({ mode: 'simulation', playing: false, now });
  });

  it('rejects a speed that is not a positive number', () => {
    const { sim } = setup();
    for (const speed of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => sim.play(speed)).toThrow(RangeError);
    }
  });

  it('load starts a new run whose first batch starts from its first event', () => {
    const { sim, frame, last, topology } = setup({ period: 10 });
    sim.play(1);
    frame(50);
    sim.pause();

    sim.load(topology);
    frame();
    expect(last()).toMatchObject({ now: 0, playing: false, events: [{ id: 1, kind: 'link' }] });
  });

  it('sends batches only to the latest listener', () => {
    const { sim, frame, batches } = setup();
    const replacement = vi.fn();
    sim.subscribe(replacement);
    frame();

    expect(batches).toEqual([]);
    expect(replacement).toHaveBeenCalledOnce();
  });

  it('answers runCommand with not-implemented', () => {
    const { sim, pc } = setup();
    expect(sim.runCommand(pc.id, 'show version')).toEqual({ kind: 'not-implemented' });
  });
});
