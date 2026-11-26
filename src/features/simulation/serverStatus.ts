import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import type { ServerStatus } from '@/engine/api';
import type { SimClient, TopologySource } from '@/engine/client';
import type { DeviceId } from '@/model';
import { trackLiveState } from './liveState';

/**
 * What each server's services hold as the simulation runs: its syslog, its mailboxes and its
 * clock. None of it is config, so the Services tab reads it here.
 */
export const serverStatuses = createStore<Partial<Record<DeviceId, ServerStatus>>>(() => ({}));

/** A server's live status, or undefined for any other device or before it is known. */
export function useServerStatus(device: DeviceId): ServerStatus | undefined {
  return useStore(serverStatuses, (statuses) => statuses[device]);
}

/** Keeps every server's status in `serverStatuses`. Returns a function that stops it. */
export function trackServerStatus(
  client: Pick<SimClient, 'sim' | 'onBatch'>,
  source: TopologySource,
): () => void {
  return trackLiveState(
    client,
    source,
    serverStatuses,
    (device) => device.kind === 'server',
    (server) => client.sim.serverStatus(server),
  );
}
