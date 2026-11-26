import { openConsole } from '@/cli';
import type { DeviceId } from '@/model';
import { editorStore, type EditorStore } from '@/model/store';
import type { SimClient } from '@/engine/client';
import { createVtyRegistry, deviceStack, type VtyRegistry } from './remote';
import type { EngineLink, SimLink } from './session';
import { createTty, type Tty } from './tty';

/** One console per router or switch, kept while the device exists. */
export interface ConsoleRegistry {
  /** The device's console, opened on first use. Undefined for a host or a missing device. */
  get(device: DeviceId): Tty | undefined;
}

/**
 * `engine` reaches the simulation for show commands that read live state, and for Telnet and SSH.
 * `vty` holds the remote sessions open on each device, shared with every other terminal.
 */
export function createConsoleRegistry(
  store: EditorStore,
  engine?: EngineLink,
  vty: VtyRegistry = createVtyRegistry(),
): ConsoleRegistry {
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
      const stack = deviceStack({ store, engine, vty }, { id, session });
      const tty = createTty(stack.session, greeting);
      ttys.set(id, tty);
      return tty;
    },
  };
}

/**
 * Prints each router or switch's syslog messages on its console. A step back replays events with
 * the ids, times and text they had, so a message already printed is not printed again.
 */
export function trackSyslog(client: Pick<SimClient, 'onBatch'>, registry: ConsoleRegistry) {
  const printed = new Set<string>();
  return client.onBatch((batch) => {
    for (const event of batch.events) {
      if (event.kind !== 'syslog') continue;
      const key = `${event.id} ${event.time} ${event.device} ${event.text}`;
      if (printed.has(key)) continue;
      printed.add(key);
      registry.get(event.device)?.log([event.text]);
    }
  });
}

/** The client's calls a console makes, and the simulated clock as its batches report it. */
function linkTo({ sim, onBatch, ping, traceroute, openTerminal }: SimClient): SimLink {
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
    layer2Status: (device) => sim.layer2Status(device),
    now: () => now,
    ping,
    traceroute,
    cancel: (handle) => sim.cancel(handle),
    openTerminal,
    terminalSend: (handle, text) => sim.terminalSend(handle, text),
    terminalClose: (handle, server) => sim.terminalClose(handle, server),
  };
}

let appLink: Promise<SimLink> | undefined;

/**
 * The app's simulation. startEngine returns the client the app already started, so this connects
 * to the running worker rather than starting another.
 */
export const appEngine: EngineLink = () =>
  (appLink ??= import('@/engine/client')
    .then(({ startEngine }) => startEngine(editorStore))
    .then(linkTo));

/** The Telnet and SSH sessions open on the app's devices, whichever terminal opened them. */
export const vtySessions = createVtyRegistry();

export const consoles = createConsoleRegistry(editorStore, appEngine, vtySessions);
