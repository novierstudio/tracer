import type { Ipv4Address, Ipv4Cidr, PrefixLength } from '@/model';

// IPv4 math for the engine. ipv4ToUint32, uint32ToIpv4 and prefixMask copy src/model/values.ts,
// whose zod schemas would otherwise ride into the worker bundle. NOV-206 wants this math shared
// with the CLI and the inspector: move it to a schema-free model module and import it from both.

export function ipv4ToUint32(address: Ipv4Address): number {
  return address.split('.').reduce((acc, octet) => acc * 256 + Number(octet), 0);
}

export function uint32ToIpv4(value: number): Ipv4Address {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 0xff).join('.') as Ipv4Address;
}

function prefixMask(prefixLength: PrefixLength): number {
  return prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0;
}

/** The network number of an address under a prefix length, as a 32-bit number. */
export function networkNumber(address: Ipv4Address, prefixLength: PrefixLength): number {
  return (ipv4ToUint32(address) & prefixMask(prefixLength)) >>> 0;
}

/** `10.1.2.3/24` as `10.1.2.0/24`. */
export function networkOf({ address, prefixLength }: Ipv4Cidr): Ipv4Cidr {
  return { address: uint32ToIpv4(networkNumber(address, prefixLength)), prefixLength };
}

export function inPrefix({ address, prefixLength }: Ipv4Cidr, candidate: Ipv4Address): boolean {
  return networkNumber(candidate, prefixLength) === networkNumber(address, prefixLength);
}

/** Orders addresses numerically, as IOS lists them. */
export const compareAddresses = (a: Ipv4Address, b: Ipv4Address) =>
  ipv4ToUint32(a) - ipv4ToUint32(b);
