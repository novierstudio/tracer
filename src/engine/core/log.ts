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
};

/** A ring buffer that keeps the newest `capacity` events. */
export function createEventLog(capacity: number): EventLogWriter {
  let buffer: SimEvent[] = [];
  let lastId = 0;

  return {
    get lastId() {
      return lastId as EventId;
    },
    since(id) {
      const first = Math.max(id + 1, lastId - capacity + 1, 1);
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
    },
  };
}
