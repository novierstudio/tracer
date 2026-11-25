import { z } from 'zod';

export const Ipv4Address = z.ipv4('Invalid IPv4 address').brand<'Ipv4Address'>();
export type Ipv4Address = z.infer<typeof Ipv4Address>;

export const PrefixLength = z
  .int('Prefix length must be a whole number')
  .min(0, 'Prefix length must be between 0 and 32')
  .max(32, 'Prefix length must be between 0 and 32')
  .brand<'PrefixLength'>();
export type PrefixLength = z.infer<typeof PrefixLength>;

export const Ipv4Cidr = z.object({ address: Ipv4Address, prefixLength: PrefixLength });
export type Ipv4Cidr = z.infer<typeof Ipv4Cidr>;

/** `10.0.0.1` as the 32-bit number 167772161. */
export function ipv4ToUint32(address: string): number {
  return address.split('.').reduce((acc, octet) => acc * 256 + Number(octet), 0);
}

export const SubnetMask = z
  .ipv4('Invalid subnet mask')
  .transform((mask, ctx) => {
    const hostBits = ~ipv4ToUint32(mask) >>> 0;
    if ((hostBits & (hostBits + 1)) !== 0) {
      ctx.addIssue({ code: 'custom', message: 'Subnet mask bits must be contiguous' });
      return z.NEVER;
    }
    return 32 - Math.log2(hostBits + 1);
  })
  .pipe(PrefixLength);

export function uint32ToIpv4(value: number): Ipv4Address {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 0xff).join('.') as Ipv4Address;
}

/** The netmask of a prefix length as a 32-bit number: /24 is 0xffffff00. */
export function prefixMask(prefixLength: PrefixLength): number {
  return prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0;
}

export function formatSubnetMask(prefixLength: PrefixLength): string {
  return uint32ToIpv4(prefixMask(prefixLength));
}

const MAC_PATTERN =
  /^(?:[0-9a-f]{2}([:-])[0-9a-f]{2}(?:\1[0-9a-f]{2}){4}|[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4})$/i;

export const MacAddress = z
  .string()
  .regex(MAC_PATTERN, 'Invalid MAC address')
  .transform((text) => {
    const hex = text.replace(/[^0-9a-f]/gi, '').toLowerCase();
    return [0, 2, 4, 6, 8, 10].map((i) => hex.slice(i, i + 2)).join(':');
  })
  .brand<'MacAddress'>();
export type MacAddress = z.infer<typeof MacAddress>;

export const VlanId = z
  .int('VLAN ID must be a whole number')
  .min(1, 'VLAN ID must be between 1 and 4094')
  .max(4094, 'VLAN ID must be between 1 and 4094')
  .brand<'VlanId'>();
export type VlanId = z.infer<typeof VlanId>;

export const Hostname = z
  .string()
  .regex(
    /^[A-Za-z](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9])?$/,
    'Hostname must start with a letter, end with a letter or digit, use only letters, digits, hyphens and underscores, and be at most 63 characters',
  )
  .brand<'Hostname'>();
export type Hostname = z.infer<typeof Hostname>;
