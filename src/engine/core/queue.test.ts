import { describe, expect, it } from 'vitest';
import { createEventQueue, type EventQueue } from './queue';
import { createRandom } from './random';
import { simTime } from './time';

function drain<T>(queue: EventQueue<T>): T[] {
  const values: T[] = [];
  for (let entry = queue.pop(); entry; entry = queue.pop()) values.push(entry.value);
  return values;
}

describe('createEventQueue', () => {
  it('pops entries in time order, whatever order they were pushed in', () => {
    const queue = createEventQueue<string>();
    queue.push(simTime(30), 'c');
    queue.push(simTime(10), 'a');
    queue.push(simTime(20), 'b');
    queue.push(simTime(0.5), 'first');

    expect(drain(queue)).toEqual(['first', 'a', 'b', 'c']);
  });

  it('pops entries for the same time in the order they were pushed', () => {
    const queue = createEventQueue<string>();
    queue.push(simTime(5), 'later');
    for (const value of ['one', 'two', 'three', 'four', 'five']) queue.push(simTime(1), value);
    queue.push(simTime(0), 'earlier');

    expect(drain(queue)).toEqual(['earlier', 'one', 'two', 'three', 'four', 'five', 'later']);
  });

  it('orders thousands of shuffled entries by time, then by push order', () => {
    const random = createRandom(42);
    const queue = createEventQueue<{ time: number; pushed: number }>();
    for (let pushed = 0; pushed < 5000; pushed++) {
      const time = Math.floor(random() * 100);
      queue.push(simTime(time), { time, pushed });
    }

    const popped = drain(queue);
    const expected = [...popped].sort((a, b) => a.time - b.time || a.pushed - b.pushed);
    expect(popped).toHaveLength(5000);
    expect(popped).toEqual(expected);
  });

  it('peek shows the next entry without removing it', () => {
    const queue = createEventQueue<string>();
    expect(queue.peek()).toBeUndefined();
    queue.push(simTime(2), 'b');
    queue.push(simTime(1), 'a');

    expect(queue.peek()?.value).toBe('a');
    expect(queue.peek()?.time).toBe(1);
    expect(drain(queue)).toEqual(['a', 'b']);
  });

  it('skips cancelled entries, and cancelling twice or after a pop changes nothing', () => {
    const queue = createEventQueue<string>();
    const a = queue.push(simTime(1), 'a');
    const b = queue.push(simTime(2), 'b');
    queue.push(simTime(3), 'c');

    queue.cancel(b);
    queue.cancel(b);
    expect(queue.pop()).toBe(a);
    queue.cancel(a);

    expect(drain(queue)).toEqual(['c']);
  });

  it('keeps its order when most entries are cancelled', () => {
    const queue = createEventQueue<number>();
    const entries = Array.from({ length: 1000 }, (_, index) =>
      queue.push(simTime(1000 - index), index),
    );
    for (const entry of entries) if (entry.value % 10 !== 0) queue.cancel(entry);

    const survivors = entries.filter((entry) => entry.value % 10 === 0).map((e) => e.value);
    expect(drain(queue)).toEqual(survivors.reverse());
  });

  it('clear empties the queue and restarts push order', () => {
    const queue = createEventQueue<string>();
    queue.push(simTime(1), 'old');
    queue.clear();
    expect(queue.pop()).toBeUndefined();

    const entry = queue.push(simTime(1), 'new');
    expect(entry.seq).toBe(0);
    expect(drain(queue)).toEqual(['new']);
  });
});

describe('save and restore', () => {
  it('rebuilds the same pop order, ties included, and keeps counting pushes from where it was', () => {
    const queue = createEventQueue<string>();
    queue.push(simTime(2), 'tie one');
    const gone = queue.push(simTime(1), 'cancelled');
    queue.push(simTime(2), 'tie two');
    queue.push(simTime(0), 'first');
    queue.cancel(gone);
    const saved = queue.save();

    queue.push(simTime(0), 'after the save');
    const restored = queue.restore(saved.entries, saved.seq);
    expect(restored.map((entry) => entry.value).sort()).toEqual(['first', 'tie one', 'tie two']);
    queue.push(simTime(2), 'tie three');

    expect(drain(queue)).toEqual(['first', 'tie one', 'tie two', 'tie three']);
  });

  it('hands back live handles, so a restored entry can be cancelled', () => {
    const queue = createEventQueue<string>();
    queue.push(simTime(1), 'a');
    queue.push(simTime(2), 'b');
    const saved = queue.save();

    const [a] = queue.restore(
      saved.entries.filter((entry) => entry.value === 'a'),
      saved.seq,
    );
    queue.cancel(a!);
    expect(drain(queue)).toEqual([]);
  });
});
