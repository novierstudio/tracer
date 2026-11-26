import type {
  DeviceUnavailable,
  DhcpOutcome,
  DnsLookup,
  PingEvent,
  PingSummary,
  ProbeHandle,
  TraceEvent,
} from '@/engine/api';
import type { SimClient, TopologySource } from '@/engine/client';
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
  // The simulated clock as of the latest batch, which a paused simulation leaves standing still.
  let now = 0;
  let tracked: Promise<SimClient> | undefined;
  const engine = () =>
    (tracked ??= import('@/engine/client')
      .then(({ startEngine }) => startEngine(source))
      .then((client) => {
        client.onBatch((batch) => void (now = batch.now));
        return client;
      }));
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
    async hostIp(device) {
      const addressing = await (await engine()).sim.hostIp(device);
      if (!addressing.ok) throw new Error(`IPCONFIG: ${UNAVAILABLE[addressing.error]}`);
      return { addressing: addressing.value, now };
    },
    async ipv6Status(device) {
      const status = await (await engine()).sim.ipv6Status(device);
      if (!status.ok) throw new Error(`IPV6CONFIG: ${UNAVAILABLE[status.error]}`);
      return status.value;
    },
    async renewDhcp(device) {
      const client = await engine();
      let settle!: (outcome: DhcpOutcome) => void;
      const outcome = new Promise<DhcpOutcome>((resolve) => (settle = resolve));
      const started = await client.dhcpRenew(device, (heard) => settle(heard));
      if (!started.ok) throw new Error(`IPCONFIG: ${UNAVAILABLE[started.error]}`);
      return outcome;
    },
    async releaseDhcp(device) {
      const released = await (await engine()).sim.dhcpRelease(device);
      if (!released.ok) throw new Error(`IPCONFIG: ${UNAVAILABLE[released.error]}`);
    },
    async nslookup(device, name, server) {
      const client = await engine();
      let settle!: (lookup: DnsLookup) => void;
      const lookup = new Promise<DnsLookup>((resolve) => (settle = resolve));
      const started = await client.resolve(device, name, server, (heard) => settle(heard));
      if (!started.ok) throw new Error(`*** Can't look up ${name}: ${UNAVAILABLE[started.error]}`);
      return lookup;
    },
    async browse(device, target, onEvent, signal) {
      const client = await engine();
      let finish!: () => void;
      const finished = new Promise<void>((resolve) => (finish = resolve));
      const started = await client.browse(device, target, (event) => {
        if (!signal.aborted) onEvent(event);
        if (event.kind === 'response' || event.kind === 'failed') finish();
      });
      if (!started.ok) throw new Error(`The page could not load: ${UNAVAILABLE[started.error]}`);
      if (signal.aborted) finish();
      else signal.addEventListener('abort', finish, { once: true });
      await finished;
    },
  };
}
