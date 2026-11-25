import { describe, expect, it } from 'vitest';
import { cloneState } from './clone';

describe('cloneState', () => {
  it('copies objects, arrays, Maps and Sets deeply, so editing the copy leaves the original', () => {
    const original = {
      table: new Map([['a', { port: 'Fa0/1', hits: [1, 2] }]]),
      seen: new Set(['x']),
      count: 3,
    };
    const copy = cloneState(original);
    copy.table.get('a')!.hits.push(3);
    copy.seen.add('y');
    copy.count = 4;

    expect(original).toEqual({
      table: new Map([['a', { port: 'Fa0/1', hits: [1, 2] }]]),
      seen: new Set(['x']),
      count: 3,
    });
    expect(copy.table.get('a')!.hits).toEqual([1, 2, 3]);
  });

  it('keeps a value reached twice shared in the copy, and functions as they are', () => {
    const listener = () => {};
    const session = { id: 1, listener };
    const original = { sessions: new Map([[1, session]]), latest: session };
    const copy = cloneState(original);

    expect(copy.latest).toBe(copy.sessions.get(1));
    expect(copy.latest).not.toBe(session);
    expect(copy.latest.listener).toBe(listener);
  });

  it('refuses state that is not plain data', () => {
    expect(() => cloneState({ when: new Date(0) })).toThrow(/plain data, got Date/);
  });
});
