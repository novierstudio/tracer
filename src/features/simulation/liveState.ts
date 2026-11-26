import type { StoreApi } from 'zustand/vanilla';
import type { SimClient, TopologySource } from '@/engine/client';
import type { Device, DeviceId, Result } from '@/model';

export type LiveStore<T> = StoreApi<Partial<Record<DeviceId, T>>>;

/**
 * Asks the simulation about every device `picks` chooses now, then again after each batch that
 * logged something and each edit, one round at a time, and keeps the answers in `store`. A device
 * whose answer did not change keeps its object, so what shows it does not re-render. Returns a
 * function that stops it.
 */
export function trackLiveState<T>(
  client: Pick<SimClient, 'onBatch'>,
  source: TopologySource,
  store: LiveStore<T>,
  picks: (device: Device) => boolean,
  ask: (device: DeviceId) => Promise<Result<T, unknown>>,
): () => void {
  let running = false;
  let again = false;
  let stopped = false;
  const refresh = async () => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    do {
      again = false;
      const devices = Object.values(source.getState().topology.devices).filter(picks);
      const answers = await Promise.all(devices.map((device) => ask(device.id)));
      if (stopped) return;
      const shown = store.getState();
      const next: Partial<Record<DeviceId, T>> = {};
      devices.forEach((device, index) => {
        const answer = answers[index];
        if (!answer?.ok) return;
        const before = shown[device.id];
        next[device.id] =
          before && JSON.stringify(before) === JSON.stringify(answer.value) ? before : answer.value;
      });
      const changed =
        Object.keys(next).length !== Object.keys(shown).length ||
        Object.entries(next).some(([id, value]) => shown[id as DeviceId] !== value);
      if (changed) store.setState(next, true);
    } while (again);
    running = false;
  };
  void refresh();
  const stopBatches = client.onBatch((batch) => {
    if (batch.events.length > 0) void refresh();
  });
  const stopEdits = source.subscribe(() => void refresh());
  return () => {
    stopped = true;
    stopBatches();
    stopEdits();
  };
}
