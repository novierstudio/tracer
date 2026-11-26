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

/** The class A, B or C prefix length of an address: 8, 16 or 24. Class D and E have none. */
export function classfulLength(address: Ipv4Address): PrefixLength | undefined {
  const first = Number(address.split('.')[0]);
  if (first < 128) return 8 as PrefixLength;
  if (first < 192) return 16 as PrefixLength;
  if (first < 224) return 24 as PrefixLength;
  return undefined;
}

/** The classful network an address is in, such as 10.0.0.0/8 for 10.1.2.3. */
export function classfulNetwork(address: Ipv4Address): Ipv4Cidr | undefined {
  const prefixLength = classfulLength(address);
  return prefixLength === undefined ? undefined : networkOf({ address, prefixLength });
}

/** Whether an address matches `network` under a wildcard mask, whose 1 bits may differ. */
export function matchesWildcard(
  address: Ipv4Address,
  network: Ipv4Address,
  wildcard: Ipv4Address,
): boolean {
  const care = ~ipv4ToUint32(wildcard) >>> 0;
  return (ipv4ToUint32(address) & care) >>> 0 === (ipv4ToUint32(network) & care) >>> 0;
}
