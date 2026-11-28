import type { DeviceId, StoredFile } from '@/model';
import { editorStore, type EditorStore } from '@/model/store';
import { appEngine, vtySessions } from '@/features/terminal/registry';
import { deviceStack, type RemoteStack } from '@/features/terminal/remote';
import type { HostBackend } from './backend';
import { engineBackend } from './engineBackend';
import { saveHostFile } from './files';
import { isHostDevice, nicConnected } from './format';
import { hostShell } from './shell';
import { createHostTty, type HostTty } from './tty';

/** One Command Prompt per PC or server, kept while the device exists. */
export interface HostPromptRegistry {
  /** The host's prompt, opened on first use. Undefined for a router, a switch or a missing device. */
  get(device: DeviceId): HostTty | undefined;
}

/** `remote` makes the stack each Telnet or SSH login runs in. */
export function createHostPromptRegistry(
  store: EditorStore,
  backend: HostBackend,
  remote?: () => RemoteStack,
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
    return { device, connected: nicConnected(topology, device) };
  };
  return {
    get(id) {
      const open = ttys.get(id);
      if (open) return open;
      if (!isHostDevice(store.getState().topology.devices[id])) return undefined;
      const saveFile = (file: StoredFile) => void saveHostFile(store, id, file);
      const shell = hostShell({ host: host(id), backend, saveFile, ...(remote && { remote }) });
      const tty = createHostTty(shell);
      ttys.set(id, tty);
      return tty;
    },
  };
}

/** The app's one host backend, shared by every Command Prompt and Web Browser. */
export const hostBackend = engineBackend(editorStore);

export const hostPrompts = createHostPromptRegistry(editorStore, hostBackend, () =>
  deviceStack({ store: editorStore, engine: appEngine, vty: vtySessions }),
);
