import { linkAt, type DeviceId } from '@/model';
import { editorStore, type EditorStore } from '@/model/store';
import type { HostBackend } from './backend';
import { engineBackend } from './engineBackend';
import { addressPort, isHostDevice } from './format';
import { hostShell } from './shell';
import { createHostTty, type HostTty } from './tty';

/** One Command Prompt per PC or server, kept while the device exists. */
export interface HostPromptRegistry {
  /** The host's prompt, opened on first use. Undefined for a router, a switch or a missing device. */
  get(device: DeviceId): HostTty | undefined;
}

export function createHostPromptRegistry(
  store: EditorStore,
  backend: HostBackend,
): HostPromptRegistry {
  const ttys = new Map<DeviceId, HostTty>();
  store.subscribe(({ topology }) => {
    for (const [id, tty] of ttys) {
      if (id in topology.devices) continue;
      tty.stop();
      ttys.delete(id);
    }
  });
  const host = (id: DeviceId) => () => {
    const { topology } = store.getState();
    const device = topology.devices[id];
    if (!isHostDevice(device)) return undefined;
    const port = addressPort(device);
    const connected = !!port && !!linkAt(topology, { device: id, port: port.id });
    return { device, connected };
  };
  return {
    get(id) {
      const open = ttys.get(id);
      if (open) return open;
      if (!isHostDevice(store.getState().topology.devices[id])) return undefined;
      const tty = createHostTty(hostShell({ host: host(id), backend }));
      ttys.set(id, tty);
      return tty;
    },
  };
}

/** The app's one host backend, shared by every Command Prompt and Web Browser. */
export const hostBackend = engineBackend(editorStore);

export const hostPrompts = createHostPromptRegistry(editorStore, hostBackend);
