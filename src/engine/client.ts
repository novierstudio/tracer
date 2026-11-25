import * as Comlink from 'comlink';
import type { Topology } from '@/model';
import type { SimAPI, SimEventBatch } from './api';
import { diffTopology } from './patch';

/** The editor store's shape, as far as syncing needs it. */
export type TopologySource = {
  getState(): { topology: Topology };
  subscribe(listener: (state: { topology: Topology }) => void): () => void;
};

export type BatchListener = (batch: SimEventBatch) => void;

export type SimClient = {
  /** Calls into the worker. Batches arrive through `onBatch`, which owns the worker's listener. */
  sim: Omit<Comlink.Remote<SimAPI>, 'subscribe'>;
  onBatch(listener: BatchListener): () => void;
};

let started: Promise<SimClient> | undefined;

/**
 * Starts the simulation worker once, loads the source's topology, and sends a patch on every
 * later change. Resolves when the worker has answered and its first batch has arrived. Later
 * calls return the same client.
 */
export function startEngine(source: TopologySource): Promise<SimClient> {
  started ??= connect(source);
  return started;
}

async function connect(source: TopologySource): Promise<SimClient> {
  const worker = new Worker(new URL('../workers/sim.worker.ts', import.meta.url), {
    type: 'module',
    name: 'simulation',
  });
  const sim = Comlink.wrap<SimAPI>(worker);

  const listeners = new Set<BatchListener>();
  const onBatch = (listener: BatchListener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const firstBatch = new Promise<void>((resolve) => {
    const stop = onBatch(() => {
      stop();
      resolve();
    });
  });
  const subscribed = sim.subscribe(
    Comlink.proxy((batch: SimEventBatch) => {
      for (const listener of listeners) listener(batch);
    }),
  );

  let synced = source.getState().topology;
  const loaded = sim.load(synced);
  source.subscribe(({ topology }) => {
    const patch = diffTopology(synced, topology);
    synced = topology;
    if (patch) void sim.applyPatch(patch);
  });

  await Promise.all([subscribed, loaded, firstBatch]);
  return { sim, onBatch };
}
