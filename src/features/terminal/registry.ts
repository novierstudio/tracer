import { openConsole } from '@/cli';
import type { DeviceId } from '@/model';
import { editorStore, type EditorStore } from '@/model/store';
import type { SimClient } from '@/engine/client';
import { deviceTerminal, type EngineLink, type SimLink } from './session';
import { createTty, type Tty } from './tty';

/** One console per router or switch, kept while the device exists. */
export interface ConsoleRegistry {
  /** The device's console, opened on first use. Undefined for a host or a missing device. */
  get(device: DeviceId): Tty | undefined;
}

/** `engine` reaches the simulation for show commands that read live state. */
export function createConsoleRegistry(store: EditorStore, engine?: EngineLink): ConsoleRegistry {
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
      const tty = createTty(deviceTerminal(store, id, session, engine), greeting);
      ttys.set(id, tty);
      return tty;
    },
  };
}

/** The client's calls a console makes, and the simulated clock as its batches report it. */
function linkTo({ sim, onBatch, ping, traceroute }: SimClient): SimLink {
  let now = 0;
  // A playing simulation sends a batch every frame, and a paused one's clock stands still.
  onBatch((batch) => void (now = batch.now));
  return {
    routes: (device) => sim.routes(device),
    arpTable: (device) => sim.arpTable(device),
    macTable: (device) => sim.macTable(device),
    portStates: (device) => sim.portStates(device),
    spanningTree: (device) => sim.spanningTree(device),
    dhcpBindings: (device) => sim.dhcpBindings(device),
    routingProtocols: (device) => sim.routingProtocols(device),
    aclHits: (device) => sim.aclHits(device),
    natTranslations: (device) => sim.natTranslations(device),
    clearNatTranslations: (device) => sim.clearNatTranslations(device),
    ipv6Status: (device) => sim.ipv6Status(device),
    now: () => now,
    ping,
    traceroute,
    cancel: (handle) => sim.cancel(handle),
  };
}

let appLink: Promise<SimLink> | undefined;

/**
 * The app's simulation. startEngine returns the client the app already started, so this connects
 * to the running worker rather than starting another.
 */
const appEngine: EngineLink = () =>
  (appLink ??= import('@/engine/client')
    .then(({ startEngine }) => startEngine(editorStore))
    .then(linkTo));

export const consoles = createConsoleRegistry(editorStore, appEngine);
