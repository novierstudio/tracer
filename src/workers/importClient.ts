import { proxy, wrap } from 'comlink';
import type { PktImport, PktImportError, PktStage } from '@/importers/pkt/mapper';
import type { Result } from '@/model';
import type { ImportWorkerApi } from './import.worker';

export type PktImportRequest = {
  /** The lab name, such as the file name. */
  readonly name: string;
  readonly onStage: (stage: PktStage) => void;
  /** Aborting stops the worker and rejects with the signal's reason. */
  readonly signal?: AbortSignal;
};

export type StartWorker = () => Worker;

// A new URL inside `new Worker` is what lets Vite bundle the worker under the app's base path.
const startImportWorker: StartWorker = () =>
  new Worker(new URL('./import.worker.ts', import.meta.url), { type: 'module', name: 'import' });

async function importOnMainThread(bytes: Uint8Array, { name, onStage }: PktImportRequest) {
  const { importPkt } = await import('@/importers/pkt/mapper');
  return importPkt(bytes, { name, onStage });
}

/**
 * Runs `importPkt` in a fresh worker so a big file does not freeze the page, and stops the worker
 * when it is done. Runs on the main thread instead when the worker cannot start.
 */
export async function importPktInWorker(
  bytes: Uint8Array,
  request: PktImportRequest,
  startWorker: StartWorker = startImportWorker,
): Promise<Result<PktImport, PktImportError>> {
  const { signal } = request;
  signal?.throwIfAborted();
  let worker: Worker;
  try {
    worker = startWorker();
  } catch {
    return importOnMainThread(bytes, request);
  }
  try {
    // An error event means the worker script did not load or run. Calls into it would never settle.
    const failed = new Promise<'failed'>((resolve) =>
      worker.addEventListener('error', () => resolve('failed'), { once: true }),
    );
    const aborted = new Promise<never>((_, reject) =>
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true }),
    );
    const api = wrap<ImportWorkerApi>(worker);
    const outcome = await Promise.race([
      api.importPkt(bytes, request.name, proxy(request.onStage)),
      failed,
      aborted,
    ]);
    if (outcome !== 'failed') return outcome;
  } finally {
    worker.terminate();
  }
  signal?.throwIfAborted();
  return importOnMainThread(bytes, request);
}
