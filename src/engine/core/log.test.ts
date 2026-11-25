import { describe, expect, it } from 'vitest';
import type { EventId } from '../events';
import { createEventLog } from './log';
import { simTime } from './time';
import type { LinkId } from '@/model';

const link = 'lnk_a' as LinkId;
const event = (time: number) => ({ kind: 'link' as const, time: simTime(time), link, up: true });
const id = (value: number) => value as EventId;

describe('createEventLog', () => {
  it('numbers events from 1 and returns the ones after an id', () => {
    const log = createEventLog(10);
    expect(log.lastId).toBe(0);
    for (const time of [0, 1, 2]) log.append(event(time));

    expect(log.lastId).toBe(3);
    expect(log.since(id(0)).map((e) => [e.id, e.time])).toEqual([
      [1, 0],
      [2, 1],
      [3, 2],
    ]);
    expect(log.since(id(2)).map((e) => e.id)).toEqual([3]);
    expect(log.since(id(3))).toEqual([]);
  });

  it('keeps only the newest events once it is full', () => {
    const log = createEventLog(3);
    for (let time = 0; time < 7; time++) log.append(event(time));

    expect(log.since(id(0)).map((e) => e.id)).toEqual([5, 6, 7]);
    expect(log.since(id(5)).map((e) => e.id)).toEqual([6, 7]);
  });

  it('clear restarts the ids', () => {
    const log = createEventLog(3);
    log.append(event(0));
    log.clear();
    expect(log.since(id(0))).toEqual([]);

    log.append(event(9));
    expect(log.since(id(0))).toEqual([{ id: 1, ...event(9) }]);
  });
});
