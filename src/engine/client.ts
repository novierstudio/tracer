import * as Comlink from 'comlink';
import type { LinkId, Topology } from '@/model';
import type { LinkStatus, SimAPI, SimEventBatch } from './api';
import { diffTopology } from './patch';

/** The editor store's shape, as far as syncing needs it. */
export type TopologySource = {
  getState(): { topology: Topology };
  subscribe(listener: (state: { topology: Topology }) => void): () => void;
};

export type BatchListener = (batch: SimEventBatch) => void;

export type SimClient = {
  /** Calls into the worker. Batches arrive through `onBatch`, which owns the worker's listener. */
  sim: Omit<Comlink.Remote<SimAPI>, 'subscribe' | 'ping' | 'traceroute'>;
  onBatch(listener: BatchListener): () => void;
  /** What each end of each link is doing, as of the latest batch, for listeners that join late. */
  linkStates(): Readonly<Record<LinkId, LinkStatus>>;
  /** SimAPI.ping, with the listener proxied to the worker. */
  ping(...args: Parameters<SimAPI['ping']>): Promise<ReturnType<SimAPI['ping']>>;
  /** SimAPI.traceroute, with the listener proxied to the worker. */
  traceroute(...args: Parameters<SimAPI['traceroute']>): Promise<ReturnType<SimAPI['traceroute']>>;
};

let started: Promise<SimClient> | undefined;

/**
 * Starts the simulation worker once, loads the source's topology, plays it in realtime, and sends
 * a patch on every later change. Resolves when the worker has answered and its first batch has
 * arrived. Later calls return the same client.
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
  let links: SimEventBatch['links'] = {};
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
      links = batch.links;
      for (const listener of listeners) listener(batch);
    }),
  );

  let synced = source.getState().topology;
  const loaded = sim.load(synced);
  // The app opens in Realtime mode, and in realtime the clock runs.
  const playing = sim.play(1);
  source.subscribe(({ topology }) => {
    const patch = diffTopology(synced, topology);
    synced = topology;
    if (patch) void sim.applyPatch(patch);
  });

  await Promise.all([subscribed, loaded, playing, firstBatch]);
  return {
    sim,
    onBatch,
    linkStates: () => links,
    ping: (device, target, options, listener) =>
      sim.ping(device, target, options, Comlink.proxy(listener)),
    traceroute: (device, target, options, listener) =>
      sim.traceroute(device, target, options, Comlink.proxy(listener)),
  };
}
