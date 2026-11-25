// @vitest-environment node
import { readFileSync } from 'node:fs';
import { expose } from 'comlink';
import { describe, expect, it } from 'vitest';
import { importPkt, type PktStage } from '@/importers/pkt/mapper';
import { importPktInWorker, type StartWorker } from './importClient';

const vtp = () =>
  new Uint8Array(
    readFileSync(new URL('../importers/pkt/__fixtures__/pt8.2-vtp-lab.pkt', import.meta.url)),
  );

type FakeWorker = { worker: Worker; terminated: () => boolean };

// Speaks Comlink over a MessageChannel in this thread, as import.worker.ts does in a real worker.
function inThreadWorker(): FakeWorker {
  const { port1, port2 } = new MessageChannel();
  expose(
    {
      importPkt: (bytes: Uint8Array, name: string, onStage: (stage: PktStage) => void) =>
        importPkt(bytes, { name, onStage }),
    },
    port1 as unknown as Worker,
  );
  let terminated = false;
  const worker = Object.assign(port2, {
    terminate: () => {
      terminated = true;
      port1.close();
      port2.close();
    },
  }) as unknown as Worker;
  return { worker, terminated: () => terminated };
}

// A worker whose script fails to load: it fires `error` and never answers.
function brokenWorker(): FakeWorker {
  const target = new EventTarget();
  let terminated = false;
  const worker = Object.assign(target, {
    postMessage: () => queueMicrotask(() => target.dispatchEvent(new Event('error'))),
    terminate: () => void (terminated = true),
  }) as unknown as Worker;
  return { worker, terminated: () => terminated };
}

const deviceNames = (result: Awaited<ReturnType<typeof importPktInWorker>>) =>
  result.ok ? Object.values(result.value.topology.devices).map((d) => d.config.hostname) : [];

async function run(start: StartWorker, signal?: AbortSignal) {
  const stages: PktStage[] = [];
  const result = await importPktInWorker(
    vtp(),
    { name: 'VTP lab', onStage: (stage) => stages.push(stage), signal },
    start,
  );
  return { result, stages };
}

describe('importPktInWorker', () => {
  it('imports in the worker, reports each stage and stops the worker', async () => {
    const fake = inThreadWorker();
    const { result, stages } = await run(() => fake.worker);
    expect(result.ok && result.value.topology.meta.name).toBe('VTP lab');
    expect(deviceNames(result)).toHaveLength(3);
    await expect.poll(() => stages).toEqual(['decrypting', 'decompressing', 'mapping']);
    expect(fake.terminated()).toBe(true);
  });

  it('imports on the main thread when the worker cannot be created', async () => {
    const { result, stages } = await run(() => {
      throw new Error('Workers are blocked');
    });
    expect(deviceNames(result)).toHaveLength(3);
    expect(stages).toEqual(['decrypting', 'decompressing', 'mapping']);
  });

  it('imports on the main thread when the worker script fails to load', async () => {
    const fake = brokenWorker();
    const { result } = await run(() => fake.worker);
    expect(deviceNames(result)).toHaveLength(3);
    expect(fake.terminated()).toBe(true);
  });

  it('stops the worker when the import is cancelled', async () => {
    const fake = inThreadWorker();
    const controller = new AbortController();
    const running = run(() => fake.worker, controller.signal);
    controller.abort();
    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    expect(fake.terminated()).toBe(true);
  });
});
