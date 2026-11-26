import { openConsole } from '@/cli';
import { deviceStack, type VtyRegistry } from '@/features/terminal/remote';
import type { EngineLink } from '@/features/terminal/session';
import { createTty, type Tty } from '@/features/terminal/tty';
import { consolePeer, type DeviceId } from '@/model';
import type { EditorStore } from '@/model/store';

/** Where a PC's Terminal app gets when it connects. */
export type ConsoleReach =
  /** No console cable in the PC's RS232 port. */
  | { readonly kind: 'no-cable' }
  /** The device at the far end is powered off. */
  | { readonly kind: 'off'; readonly hostname: string }
  /** That device's console, over the cable. */
  | { readonly kind: 'open'; readonly device: DeviceId; readonly tty: Tty };

/** The console session each PC holds over its console cable, kept while the cable is in. */
export interface ConsoleCables {
  /** Connects `pc`'s Terminal app to whatever its console cable reaches. */
  connect(pc: DeviceId): ConsoleReach;
}

export function createConsoleCables(
  store: EditorStore,
  engine: EngineLink | undefined,
  vty: VtyRegistry,
): ConsoleCables {
  const sessions = new Map<DeviceId, { device: DeviceId; tty: Tty }>();
  return {
    connect(pc) {
      const { topology } = store.getState();
      const peer = consolePeer(topology, pc);
      const device = peer && topology.devices[peer.device];
      if (!device || (device.kind !== 'router' && device.kind !== 'switch')) {
        sessions.delete(pc);
        return { kind: 'no-cable' };
      }
      if (!device.powered) {
        sessions.delete(pc);
        return { kind: 'off', hostname: device.config.hostname };
      }
      const held = sessions.get(pc);
      if (held?.device === device.id) return { kind: 'open', ...held };
      // A new cable, or a new far end: a fresh console, as plugging in starts one.
      const { session, greeting } = openConsole(device);
      const stack = deviceStack({ store, engine, vty }, { id: device.id, session });
      const opened = { device: device.id, tty: createTty(stack.session, greeting) };
      sessions.set(pc, opened);
      return { kind: 'open', ...opened };
    },
  };
}
