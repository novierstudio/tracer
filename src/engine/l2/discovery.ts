import { DEFAULT_CDP_HOLDTIME, DEFAULT_CDP_TIMER, LLDP_HOLDTIME, LLDP_TIMER } from '@/model/l2';
import type { ModuleContext, SimModule } from '../module';
import type { DiscoveryStatus } from './status';

// TODO(NOV-236): CDP and LLDP land here.
export type DiscoveryState = Record<string, never>;

export const discoveryModule: SimModule<DiscoveryState> = {
  id: 'discovery',
  init: () => ({}),
};

export function discoveryStatus(_ctx: ModuleContext<DiscoveryState>): DiscoveryStatus {
  return {
    cdp: {
      enabled: false,
      timer: DEFAULT_CDP_TIMER,
      holdtime: DEFAULT_CDP_HOLDTIME,
      interfaces: [],
      neighbors: [],
    },
    lldp: { enabled: false, timer: LLDP_TIMER, holdtime: LLDP_HOLDTIME, neighbors: [] },
  };
}
