// No runtime imports: the simulation worker uses these, and must not pull in zod.
import type { DhcpLease, LabSettings, Topology } from './topology';

/** The lease IOS gives a pool with no `lease` line: one day. */
export const DEFAULT_DHCP_LEASE = 1440 as DhcpLease;

export const DEFAULT_LAB_SETTINGS: LabSettings = { stpTimers: 'fast', routingTimers: 'fast' };

/** The lab's settings, with the defaults for a lab that names none. */
export const labSettings = (topology: Topology): LabSettings =>
  topology.settings ?? DEFAULT_LAB_SETTINGS;
