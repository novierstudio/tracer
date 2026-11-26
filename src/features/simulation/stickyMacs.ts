import type { SimClient } from '@/engine/client';
import type { StickyMacEvent } from '@/engine/events';
import type { EditorStore } from '@/model/store';

/**
 * The config with the sticky address added to its port, as IOS writes a learned sticky address
 * into the running-config. Undefined when there is nothing to add.
 */
export function withStickyMac(store: EditorStore, event: StickyMacEvent) {
  const device = store.getState().topology.devices[event.device];
  if (device?.kind !== 'switch') return undefined;
  const port = device.config.interfaces[event.port];
  const security = port?.portSecurity;
  if (!port || !security || security.addresses.some((entry) => entry.mac === event.mac)) {
    return undefined;
  }
  const addresses = [...security.addresses, { mac: event.mac, sticky: true }];
  const interfaces = {
    ...device.config.interfaces,
    [event.port]: { ...port, portSecurity: { ...security, addresses } },
  };
  return { ...device.config, interfaces };
}

/**
 * Writes each sticky address the simulation learns into its switch port's config, so it shows in
 * the running-config and saves with the lab. Adding one that is there already changes nothing,
 * so a step back that replays the event is harmless. Returns a function that stops it.
 */
export function trackStickyMacs(client: Pick<SimClient, 'onBatch'>, store: EditorStore) {
  return client.onBatch((batch) => {
    for (const event of batch.events) {
      if (event.kind !== 'sticky-mac') continue;
      const config = withStickyMac(store, event);
      if (config) store.getState().updateConfig({ device: event.device, kind: 'switch', config });
    }
  });
}
