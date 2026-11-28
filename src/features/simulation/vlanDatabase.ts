import type { SimClient } from '@/engine/client';
import type { VlanDatabaseEvent } from '@/engine/events';
import { withVlanDatabase } from '@/model/vtp';
import type { EditorStore } from '@/model/store';

/**
 * The switch's config with the VTP update in place of its VLANs and revision, as IOS writes the
 * update to vlan.dat. Undefined when the config holds it already.
 */
export function withVtpUpdate(store: EditorStore, event: VlanDatabaseEvent) {
  const device = store.getState().topology.devices[event.device];
  if (device?.kind !== 'switch') return undefined;
  const config = withVlanDatabase(device.config, event.database);
  return JSON.stringify(config) === JSON.stringify(device.config) ? undefined : config;
}

/**
 * Writes each VTP update a switch takes into its config, so `show vlan` lists the VLANs and they
 * save with the lab. Writing one the config holds already changes nothing, so a step back that
 * replays the event is harmless. Returns a function that stops it.
 */
export function trackVlanDatabases(client: Pick<SimClient, 'onBatch'>, store: EditorStore) {
  return client.onBatch((batch) => {
    for (const event of batch.events) {
      if (event.kind !== 'vlan-database') continue;
      const config = withVtpUpdate(store, event);
      if (config) store.getState().updateConfig({ device: event.device, kind: 'switch', config });
    }
  });
}
