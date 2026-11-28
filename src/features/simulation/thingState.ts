import type { SimClient } from '@/engine/client';
import { iotOf } from '@/model';
import type { EditorStore } from '@/model/store';

/**
 * Writes each change an IoT server orders into the thing's config, so its Config tab shows it and
 * it saves with the lab. A state the config has already changes nothing, so a step back that
 * replays the event is harmless. Returns a function that stops it.
 */
export function trackThingState(client: Pick<SimClient, 'onBatch'>, store: EditorStore) {
  return client.onBatch((batch) => {
    for (const event of batch.events) {
      if (event.kind !== 'thing-state') continue;
      const device = store.getState().topology.devices[event.device];
      const iot = device && iotOf(device);
      if (device?.kind !== 'pc' || !iot) continue;
      if (JSON.stringify(iot.state) === JSON.stringify(event.state)) continue;
      store.getState().updateConfig({
        device: device.id,
        kind: 'pc',
        config: { ...device.config, iot: { ...iot, state: { ...event.state } } },
      });
    }
  });
}
