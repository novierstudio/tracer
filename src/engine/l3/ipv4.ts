import {
  ipv4ToUint32,
  prefixMask,
  uint32ToIpv4,
  type Ipv4Address,
  type Ipv4Cidr,
  type PrefixLength,
} from '@/model';

// CIDR math the model does not export yet. NOV-206 wants these shared with the CLI and the
// inspector, so they belong in src/model/values.ts once another agent is not editing the model.

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
