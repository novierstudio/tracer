import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import type { HostAddressing } from '@/engine/api';
import type { SimClient, TopologySource } from '@/engine/client';
import type { Device, DeviceId, Topology } from '@/model';

/**
 * What the simulation says each DHCP host's addressing is. The model never stores a lease, so the
 * canvas, the inspector and the desktop read it here. A static host's addressing is its config.
 */
export const hostAddresses = createStore<Partial<Record<DeviceId, HostAddressing>>>(() => ({}));

/** A host set to DHCP, or a home router whose Internet port is. */
const isDhcpHost = (device: Device) =>
  ((device.kind === 'pc' || device.kind === 'server') && device.config.ipv4.mode === 'dhcp') ||
  (device.kind === 'wirelessRouter' && device.config.wan.mode === 'dhcp');

/** The live addressing of a DHCP host, or undefined for any other device or before it is known. */
export function useHostAddressing(device: DeviceId): HostAddressing | undefined {
  return useStore(hostAddresses, (addresses) => addresses[device]);
}

const dhcpHosts = (topology: Topology) => Object.values(topology.devices).filter(isDhcpHost);

/**
 * Asks the simulation for every DHCP host's addressing now, then again after each batch that
 * logged something and each edit, one round at a time. A host whose addressing did not change
 * keeps its object, so what shows it does not re-render. Returns a function that stops it.
 */
export function trackHostAddresses(
  client: Pick<SimClient, 'sim' | 'onBatch'>,
  source: TopologySource,
): () => void {
  let running = false;
  let again = false;
  let stopped = false;
  const refresh = async () => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    do {
      again = false;
      const hosts = dhcpHosts(source.getState().topology);
      const answers = await Promise.all(hosts.map((host) => client.sim.hostIp(host.id)));
      if (stopped) return;
      const shown = hostAddresses.getState();
      const next: Partial<Record<DeviceId, HostAddressing>> = {};
      hosts.forEach((host, index) => {
        const answer = answers[index];
        if (!answer?.ok) return;
        const before = shown[host.id];
        next[host.id] =
          before && JSON.stringify(before) === JSON.stringify(answer.value) ? before : answer.value;
      });
      const changed =
        Object.keys(next).length !== Object.keys(shown).length ||
        Object.entries(next).some(([id, value]) => shown[id as DeviceId] !== value);
      if (changed) hostAddresses.setState(next, true);
    } while (again);
    running = false;
  };
  void refresh();
  const stopBatches = client.onBatch((batch) => {
    if (batch.events.length > 0) void refresh();
  });
  const stopEdits = source.subscribe(() => void refresh());
  return () => {
    stopped = true;
    stopBatches();
    stopEdits();
  };
}
