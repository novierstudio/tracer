import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import type { HostAddressing } from '@/engine/api';
import type { SimClient, TopologySource } from '@/engine/client';
import type { Device, DeviceId } from '@/model';
import { trackLiveState } from './liveState';

/**
 * What the simulation says each DHCP host's addressing is. The model never stores a lease, so the
 * canvas, the inspector and the desktop read it here. A static host's addressing is its config.
 */
export const hostAddresses = createStore<Partial<Record<DeviceId, HostAddressing>>>(() => ({}));

/** A host set to DHCP, a lightweight AP, or a gateway whose uplink is. */
const isDhcpHost = (device: Device) =>
  ((device.kind === 'pc' || device.kind === 'server') && device.config.ipv4.mode === 'dhcp') ||
  device.kind === 'lightweightAp' ||
  ((device.kind === 'wirelessRouter' || device.kind === 'centralOffice') &&
    device.config.wan.mode === 'dhcp');

/** The live addressing of a DHCP host, or undefined for any other device or before it is known. */
export function useHostAddressing(device: DeviceId): HostAddressing | undefined {
  return useStore(hostAddresses, (addresses) => addresses[device]);
}

/** Keeps every DHCP host's addressing in `hostAddresses`. Returns a function that stops it. */
export function trackHostAddresses(
  client: Pick<SimClient, 'sim' | 'onBatch'>,
  source: TopologySource,
): () => void {
  return trackLiveState(client, source, hostAddresses, isDhcpHost, (host) =>
    client.sim.hostIp(host),
  );
}
