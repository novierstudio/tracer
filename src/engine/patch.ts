import type { Device, DeviceId, Link, LinkId, Topology } from '@/model';

/**
 * The new value of every device and link that changed, or null for one that was removed.
 * Applying a patch sets state rather than replaying edits, so applying it twice changes nothing.
 */
export type TopologyPatch = {
  devices: Record<DeviceId, Device | null>;
  links: Record<LinkId, Link | null>;
};

const UI_ONLY_DEVICE_FIELDS: ReadonlySet<keyof Device> = new Set(['position']);

function simulatedFieldsChanged(before: Device, after: Device): boolean {
  if (before === after) return false;
  return (Object.keys(after) as (keyof Device)[]).some(
    (field) => !UI_ONLY_DEVICE_FIELDS.has(field) && before[field] !== after[field],
  );
}

/**
 * What changed between two topologies, comparing by reference as the editor store's structural
 * sharing allows. Moving a device is not a change the simulation sees.
 */
export function diffTopology(before: Topology, after: Topology): TopologyPatch | undefined {
  const patch: TopologyPatch = { devices: {}, links: {} };
  let changed = false;

  for (const [id, device] of Object.entries(after.devices) as [DeviceId, Device][]) {
    const previous = before.devices[id];
    if (!previous || simulatedFieldsChanged(previous, device)) {
      patch.devices[id] = device;
      changed = true;
    }
  }
  for (const id of Object.keys(before.devices) as DeviceId[]) {
    if (!(id in after.devices)) {
      patch.devices[id] = null;
      changed = true;
    }
  }
  for (const [id, link] of Object.entries(after.links) as [LinkId, Link][]) {
    if (before.links[id] !== link) {
      patch.links[id] = link;
      changed = true;
    }
  }
  for (const id of Object.keys(before.links) as LinkId[]) {
    if (!(id in after.links)) {
      patch.links[id] = null;
      changed = true;
    }
  }
  return changed ? patch : undefined;
}
