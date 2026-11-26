// No runtime imports: the simulation worker uses these, and must not pull in zod.
import type { HsrpGroup } from './topology';
import type { Ipv4Address, MacAddress } from './values';

export type HsrpVersion = 1 | 2;

export const HSRP_DEFAULT_PRIORITY = 100;
export const HSRP_DEFAULT_HELLO = 3;
export const HSRP_DEFAULT_HOLD = 10;
export const HSRP_DEFAULT_DECREMENT = 10;

/** The highest group number each version takes. */
export const HSRP_MAX_GROUP: Readonly<Record<HsrpVersion, number>> = { 1: 255, 2: 4095 };

/** Hellos go to all routers (224.0.0.2) in version 1, and to HSRP's own group in version 2. */
export const HSRP_GROUP_ADDRESS: Readonly<Record<HsrpVersion, Ipv4Address>> = {
  1: '224.0.0.2' as Ipv4Address,
  2: '224.0.0.102' as Ipv4Address,
};

/** HSRP's UDP port, for both versions. */
export const HSRP_PORT = 1985;

/** The password every hello carries unless `standby authentication` sets another. */
export const HSRP_DEFAULT_AUTHENTICATION = 'cisco';

/** The group's virtual MAC: 0000.0c07.acXX in version 1, 0000.0c9f.fXXX in version 2. */
export function hsrpVirtualMac(version: HsrpVersion, group: number): MacAddress {
  const hex = (value: number, width: number) => value.toString(16).padStart(width, '0');
  const tail =
    version === 1
      ? ['07', 'ac', hex(group, 2)]
      : ['9f', hex(0xf0 | (group >> 8), 2), hex(group & 0xff, 2)];
  return ['00', '00', '0c', ...tail].join(':') as MacAddress;
}

export const hsrpPriority = (group: HsrpGroup): number => group.priority ?? HSRP_DEFAULT_PRIORITY;

export const hsrpTimers = (group: HsrpGroup) =>
  group.timers ?? { hello: HSRP_DEFAULT_HELLO, hold: HSRP_DEFAULT_HOLD };
