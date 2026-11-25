import { openConsole } from '@/cli';
import type { DeviceId } from '@/model';
import { editorStore, type EditorStore } from '@/model/store';
import { deviceTerminal } from './session';
import { createTty, type Tty } from './tty';

/** One console per router or switch, kept while the device exists. */
export interface ConsoleRegistry {
  /** The device's console, opened on first use. Undefined for a host or a missing device. */
  get(device: DeviceId): Tty | undefined;
}

export function createConsoleRegistry(store: EditorStore): ConsoleRegistry {
  const ttys = new Map<DeviceId, Tty>();
  store.subscribe(({ topology }) => {
    for (const id of ttys.keys()) if (!(id in topology.devices)) ttys.delete(id);
  });
  return {
    get(id) {
      const open = ttys.get(id);
      if (open) return open;
      const device = store.getState().topology.devices[id];
      if (device?.kind !== 'router' && device?.kind !== 'switch') return undefined;
      const { session, greeting } = openConsole(device);
      const tty = createTty(deviceTerminal(store, id, session), greeting);
      ttys.set(id, tty);
      return tty;
    },
  };
}

export const consoles = createConsoleRegistry(editorStore);
