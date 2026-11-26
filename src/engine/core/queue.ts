import type { SimTime } from './time';

export type QueueEntry<T> = {
  readonly time: SimTime;
  readonly seq: number;
  readonly value: T;
  readonly queued: boolean;
};

/** What a snapshot keeps of one queued entry. */
export type SavedEntry<T> = { readonly time: SimTime; readonly seq: number; readonly value: T };

export type EventQueue<T> = {
  push(time: SimTime, value: T): QueueEntry<T>;
  /** Removes a queued entry. Harmless on one that was already popped or cancelled. */
  cancel(entry: QueueEntry<T>): void;
  peek(): QueueEntry<T> | undefined;
  /** Removes every queued entry `match` picks, and returns them in the order they would pop. */
  take(match: (entry: QueueEntry<T>) => boolean): QueueEntry<T>[];
  pop(): QueueEntry<T> | undefined;
  clear(): void;
  /** The queued entries in no particular order, and the push counter, for a snapshot. */
  save(): { entries: SavedEntry<T>[]; seq: number };
  /** Replaces the contents with saved entries. Returns their new handles, in the order given. */
  restore(entries: readonly SavedEntry<T>[], seq: number): QueueEntry<T>[];
};

type Entry<T> = { -readonly [K in keyof QueueEntry<T>]: QueueEntry<T>[K] };

const COMPACT_MIN_CANCELLED = 64;

/** A binary min-heap ordered by (time, seq). Entries pushed for the same time pop in push order. */
export function createEventQueue<T>(): EventQueue<T> {
  let heap: Entry<T>[] = [];
  let seq = 0;
  let cancelled = 0;

  const before = (a: Entry<T>, b: Entry<T>) =>
    a.time < b.time || (a.time === b.time && a.seq < b.seq);

  function siftUp(index: number) {
    const entry = heap[index]!;
    while (index > 0) {
      const parentIndex = (index - 1) >> 1;
      const parent = heap[parentIndex]!;
      if (!before(entry, parent)) break;
      heap[index] = parent;
      index = parentIndex;
    }
    heap[index] = entry;
  }

  function siftDown(index: number) {
    const entry = heap[index]!;
    for (;;) {
      let childIndex = 2 * index + 1;
      if (childIndex >= heap.length) break;
      if (childIndex + 1 < heap.length && before(heap[childIndex + 1]!, heap[childIndex]!)) {
        childIndex += 1;
      }
      const child = heap[childIndex]!;
      if (!before(child, entry)) break;
      heap[index] = child;
      index = childIndex;
    }
    heap[index] = entry;
  }

  function removeTop() {
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      siftDown(0);
    }
  }

  function peek() {
    while (heap[0] && !heap[0].queued) {
      removeTop();
      cancelled -= 1;
    }
    return heap[0];
  }

  function cancel(handle: QueueEntry<T>) {
    const entry = handle as Entry<T>;
    if (!entry.queued) return;
    entry.queued = false;
    cancelled += 1;
    if (cancelled >= COMPACT_MIN_CANCELLED && cancelled * 2 > heap.length) {
      heap = heap.filter((candidate) => candidate.queued);
      cancelled = 0;
      for (let index = (heap.length >> 1) - 1; index >= 0; index--) siftDown(index);
    }
  }

  return {
    push(time, value) {
      const entry: Entry<T> = { time, seq: seq++, value, queued: true };
      heap.push(entry);
      siftUp(heap.length - 1);
      return entry;
    },
    cancel,
    peek,
    take(match) {
      const taken = heap.filter((entry) => entry.queued && match(entry));
      for (const entry of taken) cancel(entry);
      return taken.sort((a, b) => (before(a, b) ? -1 : 1));
    },
    pop() {
      const top = peek();
      if (!top) return undefined;
      removeTop();
      top.queued = false;
      return top;
    },
    clear() {
      heap = [];
      seq = 0;
      cancelled = 0;
    },
    save() {
      const entries = heap
        .filter((entry) => entry.queued)
        .map(({ time, seq, value }) => ({ time, seq, value }));
      return { entries, seq };
    },
    restore(entries, nextSeq) {
      const restored = entries.map(({ time, seq, value }) => ({ time, seq, value, queued: true }));
      heap = [...restored];
      seq = nextSeq;
      cancelled = 0;
      for (let index = (heap.length >> 1) - 1; index >= 0; index--) siftDown(index);
      return restored;
    },
  };
}
