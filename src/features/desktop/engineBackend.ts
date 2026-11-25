import type {
  DeviceUnavailable,
  PingEvent,
  PingSummary,
  ProbeHandle,
  TraceEvent,
} from '@/engine/api';
import type { TopologySource } from '@/engine/client';
import type { Result } from '@/model';
import type { HostBackend } from './backend';

const UNAVAILABLE: Record<DeviceUnavailable, string> = {
  'unknown-device': 'this device is not in the simulation yet.',
  'powered-off': 'the device is powered off.',
  unsupported: 'this device cannot do that.',
};

/**
 * Follows a ping or traceroute to its last event, passing the others to `onEvent`. Aborting
 * `signal` cancels it in the simulation and resolves at once. `failed` words a refusal.
 */
async function follow<E, Last extends E>(
  start: (listener: (event: E) => void) => Promise<Result<ProbeHandle, DeviceUnavailable>>,
  cancel: (handle: ProbeHandle) => Promise<void>,
  isLast: (event: E) => event is Last,
  onEvent: (event: Exclude<E, Last>) => void,
  signal: AbortSignal,
  failed: (why: string) => string,
): Promise<void> {
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => (finish = resolve));
  const started = await start((event) => {
    if (isLast(event)) finish();
    else if (!signal.aborted) onEvent(event as Exclude<E, Last>);
  });
  if (!started.ok) throw new Error(failed(UNAVAILABLE[started.error]));
  const stop = () => {
    void cancel(started.value).catch(() => {});
    finish();
  };
  if (signal.aborted) stop();
  else signal.addEventListener('abort', stop, { once: true });
  await finished;
}

/**
 * The Command Prompt's backend: the simulation worker's ping, traceroute and ARP cache, through
 * the client `startEngine` shares with the rest of the app. The client loads on first use.
 */
export function engineBackend(source: TopologySource): HostBackend {
  const engine = () => import('@/engine/client').then(({ startEngine }) => startEngine(source));
  return {
    async ping(device, target, options, onReply, signal) {
      const client = await engine();
      await follow<PingEvent, PingSummary>(
        (listener) => client.ping(device, target, options, listener),
        (handle) => client.sim.cancel(handle),
        (event) => event.kind === 'summary',
        onReply,
        signal,
        (why) => `PING: transmit failed, ${why}`,
      );
    },
    async traceroute(device, target, options, onProbe, signal) {
      const client = await engine();
      await follow<TraceEvent, Extract<TraceEvent, { kind: 'done' }>>(
        (listener) => client.traceroute(device, target, options, listener),
        (handle) => client.sim.cancel(handle),
        (event) => event.kind === 'done',
        onProbe,
        signal,
        (why) => `TRACERT: transmit failed, ${why}`,
      );
    },
    async arpTable(device) {
      const table = await (await engine()).sim.arpTable(device);
      if (!table.ok) throw new Error(`ARP: ${UNAVAILABLE[table.error]}`);
      return table.value;
    },
    async clearArp(device, address) {
      const cleared = await (await engine()).sim.clearArp(device, address);
      if (!cleared.ok) throw new Error(`ARP: ${UNAVAILABLE[cleared.error]}`);
      return cleared.value;
    },
  };
}
