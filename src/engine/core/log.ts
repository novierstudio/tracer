import type { EventId, NewEvent, SimEvent } from '../events';

export type EventLog = {
  /** The id of the newest event, or 0 when the log is empty. */
  readonly lastId: EventId;
  /** The events after `id` that the log still holds, oldest first. */
  since(id: EventId): SimEvent[];
};

export type EventLogWriter = EventLog & {
  append(event: NewEvent): void;
  clear(): void;
  /** Forgets every event after `id`, so the next one appended gets `id + 1` again. */
  truncate(id: EventId): void;
};

/** A ring buffer that keeps the newest `capacity` events. */
export function createEventLog(capacity: number): EventLogWriter {
  let buffer: SimEvent[] = [];
  let lastId = 0;
  // No id below this is readable. Only truncation raises it above what the capacity implies.
  let firstId = 1;

  return {
    get lastId() {
      return lastId as EventId;
    },
    since(id) {
      const first = Math.max(id + 1, lastId - capacity + 1, firstId);
      const events: SimEvent[] = [];
      for (let next = first; next <= lastId; next++) events.push(buffer[(next - 1) % capacity]!);
      return events;
    },
    append(event) {
      lastId += 1;
      buffer[(lastId - 1) % capacity] = { id: lastId as EventId, ...event };
    },
    clear() {
      buffer = [];
      lastId = 0;
      firstId = 1;
    },
    truncate(id) {
      if (!Number.isInteger(id) || id < 0 || id > lastId) {
        throw new RangeError(`Can only truncate to an id from 0 to ${lastId}, got ${id}`);
      }
      // Ids up to `id` that the ring already overwrote stay lost; the ones appended next are new.
      firstId = Math.min(Math.max(firstId, lastId - capacity + 1), id + 1);
      lastId = id;
    },
  };
}
