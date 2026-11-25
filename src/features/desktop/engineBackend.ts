import type { DeviceUnavailable } from '@/engine/api';
import type { TopologySource } from '@/engine/client';
import type { HostBackend } from './backend';

const UNAVAILABLE: Record<DeviceUnavailable, string> = {
  'unknown-device': 'this device is not in the simulation yet.',
  'powered-off': 'the device is powered off.',
  unsupported: 'this device cannot do that.',
};

/**
 * The Command Prompt's backend: the simulation worker's ping and ARP table, through the client
 * `startEngine` shares with the rest of the app. The client loads on first use.
 */
export function engineBackend(source: TopologySource): HostBackend {
  const engine = () => import('@/engine/client').then(({ startEngine }) => startEngine(source));
  return {
    async ping(device, target, options, onReply, signal) {
      const client = await engine();
      let finish!: () => void;
      const finished = new Promise<void>((resolve) => (finish = resolve));
      const started = await client.ping(device, target, options, (event) => {
        if (event.kind === 'summary') finish();
        else if (!signal.aborted) onReply(event);
      });
      if (!started.ok) throw new Error(`PING: transmit failed, ${UNAVAILABLE[started.error]}`);
      // The engine cannot cancel a ping yet: Ctrl+C stops listening, and it finishes unheard.
      signal.addEventListener('abort', finish);
      await finished;
    },
    async arpTable(device) {
      const table = await (await engine()).sim.arpTable(device);
      if (!table.ok) throw new Error(`ARP: ${UNAVAILABLE[table.error]}`);
      return table.value;
    },
    clearArp: () =>
      Promise.reject(new Error('ARP: the simulation cannot clear the ARP cache yet.')),
  };
}
