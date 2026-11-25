// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildLab } from '@/model/testing';
import { createAutosave, type SaveStatus } from './autosave';
import type { LabId, LabRecord, LabStorage } from './labStorage';

function recordingStorage(put: (record: LabRecord) => Promise<void> = async () => {}) {
  const written: LabRecord[] = [];
  const storage = {
    put: async (record: LabRecord) => {
      await put(record);
      written.push(record);
    },
  } as LabStorage;
  return { written, storage: () => Promise.resolve(storage) };
}

const A = 'lab-a' as LabId;
const B = 'lab-b' as LabId;
const { topology } = buildLab();
const renamed = (name: string) => ({ ...topology, meta: { ...topology.meta, name } });

describe('autosave', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('writes once, with the latest topology, a delay after the last change', async () => {
    const { written, storage } = recordingStorage();
    const statuses: SaveStatus[] = [];
    const autosave = createAutosave({ storage, delayMs: 1000, onStatus: (s) => statuses.push(s) });

    autosave.schedule(A, renamed('one'));
    await vi.advanceTimersByTimeAsync(900);
    autosave.schedule(A, renamed('two'));
    await vi.advanceTimersByTimeAsync(900);
    expect(written).toEqual([]);
    expect(statuses.at(-1)).toBe('saving');

    await vi.advanceTimersByTimeAsync(100);
    expect(written.map((r) => [r.id, r.name, r.deviceCount])).toEqual([[A, 'two', 5]]);
    expect(statuses.at(-1)).toBe('saved');
  });

  it('flush writes the pending change at once and cancels the timer', async () => {
    const { written, storage } = recordingStorage();
    const autosave = createAutosave({ storage, delayMs: 1000, onStatus: () => {} });

    autosave.schedule(A, renamed('now'));
    await autosave.flush();
    expect(written.map((r) => r.name)).toEqual(['now']);

    await vi.advanceTimersByTimeAsync(5000);
    expect(written).toHaveLength(1);
  });

  it('writes a pending change to its own lab before switching to another', async () => {
    const { written, storage } = recordingStorage();
    const autosave = createAutosave({ storage, delayMs: 1000, onStatus: () => {} });

    autosave.schedule(A, renamed('first'));
    autosave.schedule(B, renamed('second'));
    await autosave.flush();
    expect(written.map((r) => [r.id, r.name])).toEqual([
      [A, 'first'],
      [B, 'second'],
    ]);
  });

  it('reports a quota error and recovers on the next successful write', async () => {
    let full = true;
    const { storage } = recordingStorage(async () => {
      if (full) throw new DOMException('quota', 'QuotaExceededError');
    });
    const statuses: SaveStatus[] = [];
    const autosave = createAutosave({ storage, onStatus: (s) => statuses.push(s) });

    autosave.schedule(A, topology);
    await autosave.flush();
    expect(statuses.at(-1)).toBe('full');

    full = false;
    autosave.schedule(A, topology);
    await autosave.flush();
    expect(statuses.at(-1)).toBe('saved');
  });

  it('reports storage that cannot be opened as unavailable', async () => {
    const statuses: SaveStatus[] = [];
    const autosave = createAutosave({
      storage: () => Promise.reject(new Error('blocked')),
      onStatus: (s) => statuses.push(s),
    });
    autosave.schedule(A, topology);
    await autosave.flush();
    expect(statuses.at(-1)).toBe('unavailable');
  });
});
