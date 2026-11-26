// No runtime imports: the simulation worker uses these, and must not pull in zod.
import type {
  ChannelMode,
  LoadBalance,
  PortChannelId,
  PortSecurity,
  PortSecurityViolation,
} from './topology';

/** CDP's IOS defaults: an advertisement every 60 s, which neighbours keep for 180 s. */
export const DEFAULT_CDP_TIMER = 60;
export const DEFAULT_CDP_HOLDTIME = 180;

/** LLDP's IOS defaults: an advertisement every 30 s, which neighbours keep for 120 s. */
export const LLDP_TIMER = 30;
export const LLDP_HOLDTIME = 120;

/** How long an err-disabled port waits before `errdisable recovery` brings it back, in seconds. */
export const DEFAULT_ERRDISABLE_INTERVAL = 300;

export const DEFAULT_LOAD_BALANCE: LoadBalance = 'src-mac';

export const portChannelId = (group: number) => `Port-channel${group}` as PortChannelId;

export const channelGroupOf = (id: PortChannelId) => Number(id.slice('Port-channel'.length));

/** The protocol a channel mode negotiates with. `on` negotiates nothing. */
export type ChannelProtocol = 'lacp' | 'pagp';

export function channelProtocol(mode: ChannelMode): ChannelProtocol | undefined {
  switch (mode) {
    case 'active':
    case 'passive':
      return 'lacp';
    case 'desirable':
    case 'auto':
      return 'pagp';
    case 'on':
      return undefined;
  }
}

/** The secure addresses a port takes at most. */
export const secureMaximum = (security: PortSecurity) => security.maximum ?? 1;

export const violationOf = (security: PortSecurity): PortSecurityViolation =>
  security.violation ?? 'shutdown';
