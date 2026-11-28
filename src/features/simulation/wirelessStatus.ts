import { useStore } from 'zustand';
import { useShallow } from 'zustand/shallow';
import { createStore } from 'zustand/vanilla';
import type { IotServerStatus, LapStatus, ThingStatus, WlcStatus } from '@/engine/api';
import type { SimClient, TopologySource } from '@/engine/client';
import { iotOf, runsIotServer, type ApBroadcasts, type DeviceId } from '@/model';
import { trackLiveState } from './liveState';

/**
 * What the wireless controllers, lightweight APs and IoT devices hold as the simulation runs:
 * which APs joined which controller, what each AP broadcasts, and which things registered. None
 * of it is config, so the inspector, the canvas and the PC Wireless app read it here.
 */
export const lapStatuses = createStore<Partial<Record<DeviceId, LapStatus>>>(() => ({}));
export const wlcStatuses = createStore<Partial<Record<DeviceId, WlcStatus>>>(() => ({}));
export const iotServerStatuses = createStore<Partial<Record<DeviceId, IotServerStatus>>>(
  () => ({}),
);
export const thingStatuses = createStore<Partial<Record<DeviceId, ThingStatus>>>(() => ({}));

export const useLapStatus = (device: DeviceId) =>
  useStore(lapStatuses, (statuses) => statuses[device]);
export const useWlcStatus = (device: DeviceId) =>
  useStore(wlcStatuses, (statuses) => statuses[device]);
export const useIotServerStatus = (device: DeviceId) =>
  useStore(iotServerStatuses, (statuses) => statuses[device]);
export const useThingStatus = (device: DeviceId) =>
  useStore(thingStatuses, (statuses) => statuses[device]);

/** The networks each lightweight AP broadcasts now, as `associations` takes them. */
export const apBroadcastsOf = (statuses: Partial<Record<DeviceId, LapStatus>>): ApBroadcasts =>
  Object.fromEntries(Object.entries(statuses).map(([id, status]) => [id, status?.wlans ?? []]));

export function useApBroadcasts(): ApBroadcasts {
  return useStore(lapStatuses, useShallow(apBroadcastsOf));
}

/** Keeps every AP's, controller's and IoT device's status. Returns a function that stops it. */
export function trackWirelessStatus(
  client: Pick<SimClient, 'sim' | 'onBatch'>,
  source: TopologySource,
): () => void {
  const stops = [
    trackLiveState(
      client,
      source,
      lapStatuses,
      (device) => device.kind === 'lightweightAp',
      (device) => client.sim.lapStatus(device),
    ),
    trackLiveState(
      client,
      source,
      wlcStatuses,
      (device) => device.kind === 'wlc',
      (device) => client.sim.wlcStatus(device),
    ),
    trackLiveState(client, source, iotServerStatuses, runsIotServer, (device) =>
      client.sim.iotServerStatus(device),
    ),
    trackLiveState(
      client,
      source,
      thingStatuses,
      (device) => iotOf(device) !== undefined,
      (device) => client.sim.thingStatus(device),
    ),
  ];
  return () => stops.forEach((stop) => stop());
}
