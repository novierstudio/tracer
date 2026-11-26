import type { SimClient } from '@/engine/client';
import type { ServerFilesEvent } from '@/engine/events';
import { serverServices } from '@/model';
import type { EditorStore } from '@/model/store';

/**
 * The server's config with the service keeping the event's files. Undefined when it keeps them
 * already, or the device is no longer a server.
 */
export function withServerFiles(store: EditorStore, event: ServerFilesEvent) {
  const device = store.getState().topology.devices[event.device];
  if (device?.kind !== 'server') return undefined;
  const services = serverServices(device.config);
  const service = services[event.service];
  if (JSON.stringify(service.files) === JSON.stringify(event.files)) return undefined;
  return {
    ...device.config,
    services: { ...services, [event.service]: { ...service, files: [...event.files] } },
  };
}

/**
 * Writes each upload to a TFTP or FTP server into the server's config, so its Services tab lists
 * the file and it saves with the lab. Files the config has already change nothing, so a step back
 * that replays the event is harmless. Returns a function that stops it.
 */
export function trackServerFiles(client: Pick<SimClient, 'onBatch'>, store: EditorStore) {
  return client.onBatch((batch) => {
    for (const event of batch.events) {
      if (event.kind !== 'server-files') continue;
      const config = withServerFiles(store, event);
      if (config) store.getState().updateConfig({ device: event.device, kind: 'server', config });
    }
  });
}
