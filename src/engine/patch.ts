import type { Device, DeviceId, Link, LinkId } from '@/model';

/**
 * The new value of every device and link that changed, or null for one that was removed.
 * Applying a patch sets state rather than replaying edits, so applying it twice changes nothing.
 */
export type TopologyPatch = {
  devices: Record<DeviceId, Device | null>;
  links: Record<LinkId, Link | null>;
};
