import type { Topology } from '@/model';
import type { LabId, LabRecord, LabStorage } from './labStorage';

export const AUTOSAVE_DELAY_MS = 1000;

// `saving` covers both a write waiting out the debounce and one in flight.
export type SaveStatus = 'saved' | 'saving' | 'unavailable' | 'full';

export type Autosave = ReturnType<typeof createAutosave>;

type AutosaveOptions = {
  storage: () => Promise<LabStorage>;
  onStatus: (status: SaveStatus) => void;
  onWrite?: () => void;
  delayMs?: number;
  now?: () => Date;
};

export function toLabRecord(id: LabId, topology: Topology, now: Date): LabRecord {
  return {
    id,
    name: topology.meta.name,
    updatedAt: now.toISOString(),
    deviceCount: Object.keys(topology.devices).length,
    topology,
  };
}

function failure(error: unknown): SaveStatus {
  return error instanceof DOMException && error.name === 'QuotaExceededError'
    ? 'full'
    : 'unavailable';
}

// Debounces writes of the current lab. Writes run one at a time, in order, so an older snapshot
// never lands after a newer one. Failures only change the status: the editor keeps working.
export function createAutosave({
  storage,
  onStatus,
  onWrite,
  delayMs = AUTOSAVE_DELAY_MS,
  now = () => new Date(),
}: AutosaveOptions) {
  let pending: { id: LabId; topology: Topology } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let queue = Promise.resolve();

  const write = async ({ id, topology }: { id: LabId; topology: Topology }) => {
    try {
      await (await storage()).put(toLabRecord(id, topology, now()));
      if (!pending) onStatus('saved');
      onWrite?.();
    } catch (error) {
      onStatus(failure(error));
    }
  };

  const flush = (): Promise<void> => {
    clearTimeout(timer);
    timer = undefined;
    const next = pending;
    pending = undefined;
    if (next) queue = queue.then(() => write(next));
    return queue;
  };

  return {
    schedule(id: LabId, topology: Topology) {
      if (pending && pending.id !== id) void flush();
      pending = { id, topology };
      onStatus('saving');
      clearTimeout(timer);
      timer = setTimeout(() => void flush(), delayMs);
    },
    flush,
  };
}
