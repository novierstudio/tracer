import type { Ipv4Address, PrefixLength } from '@/model';
import { networkNumber, uint32ToIpv4 } from '../../l3/ipv4';
import { LSA_TYPE, type Lsa, type LsaHeader, type RouterLink } from '../../pdu';

/**
 * LSAs as RFC 2328 lays them out in bytes: what the PDU inspector shows, and where the checksum
 * `show ip ospf database` prints comes from.
 */

/** The options byte of every packet and LSA Tracer sends: only the E bit, as a normal area sets. */
export const OSPF_OPTIONS = 0x02;

export const LINK_TYPE: Record<RouterLink['type'], number> = {
  'point-to-point': 1,
  transit: 2,
  stub: 3,
};

const u16 = (value: number) => [(value >> 8) & 0xff, value & 0xff];
const u24 = (value: number) => [(value >> 16) & 0xff, ...u16(value & 0xffff)];
const u32 = (value: number) => [...u16(Math.floor(value / 0x10000)), ...u16(value & 0xffff)];
const ipBytes = (address: string) => address.split('.').map(Number);

/** `24` as `255.255.255.0`. */
export const maskOf = (prefixLength: PrefixLength): Ipv4Address =>
  uint32ToIpv4(networkNumber('255.255.255.255' as Ipv4Address, prefixLength));

/** A link's ID and data, as RFC 2328 defines them for its type. */
export function linkIdAndData(link: RouterLink): [id: string, data: string] {
  switch (link.type) {
    case 'point-to-point':
      return [link.neighbor, link.address];
    case 'transit':
      return [link.dr, link.address];
    case 'stub':
      return [link.network, maskOf(link.prefixLength)];
  }
}

function linkBytes(link: RouterLink): number[] {
  const [id, data] = linkIdAndData(link);
  return [...ipBytes(id), ...ipBytes(data), LINK_TYPE[link.type], 0, ...u16(link.metric)];
}

function lsaBodyBytes(lsa: Lsa): number[] {
  switch (lsa.type) {
    case 'router': {
      const flags = (lsa.asbr ? 0x02 : 0) | (lsa.abr ? 0x01 : 0);
      return [flags, 0, ...u16(lsa.links.length), ...lsa.links.flatMap(linkBytes)];
    }
    case 'network':
      return [...ipBytes(maskOf(lsa.prefixLength)), ...lsa.attached.flatMap(ipBytes)];
    case 'summary':
      return [...ipBytes(maskOf(lsa.prefixLength)), 0, ...u24(lsa.metric)];
    case 'asbr-summary':
      return [0, 0, 0, 0, 0, ...u24(lsa.metric)];
    case 'external':
      return [
        ...ipBytes(maskOf(lsa.prefixLength)),
        lsa.metricType === 2 ? 0x80 : 0,
        ...u24(lsa.metric),
        0,
        0,
        0,
        0,
        ...u32(lsa.tag),
      ];
  }
}

export function lsaHeaderBytes(header: LsaHeader, checksum: number, length: number): number[] {
  return [
    ...u16(header.age),
    OSPF_OPTIONS,
    LSA_TYPE[header.type],
    ...ipBytes(header.id),
    ...ipBytes(header.advertisingRouter),
    ...u32(header.sequence >>> 0),
    ...u16(checksum),
    ...u16(length),
  ];
}

/**
 * The two check bytes, placed at `offset`, that make the Fletcher checksum (ISO 8473) of `data`
 * come out to zero. `data` holds zeros where they go.
 */
function fletcherCheck(data: readonly number[], offset: number): [number, number] {
  let c0 = 0;
  let c1 = 0;
  for (const byte of data) {
    c0 = (c0 + byte) % 255;
    c1 = (c1 + c0) % 255;
  }
  let x = ((data.length - offset - 1) * c0 - c1) % 255;
  if (x <= 0) x += 255;
  let y = 510 - c0 - x;
  if (y > 255) y -= 255;
  return [x, y];
}

/** A whole LSA's bytes, with its checksum over everything but the age, which changes in transit. */
export function lsaBytes(lsa: Lsa): number[] {
  const body = lsaBodyBytes(lsa);
  const bytes = [...lsaHeaderBytes(lsa, 0, 20 + body.length), ...body];
  const [x, y] = fletcherCheck(bytes.slice(2), 14);
  bytes[16] = x;
  bytes[17] = y;
  return bytes;
}

/** The LSA's checksum, as its header carries it. */
export function lsaChecksum(lsa: Lsa): number {
  const bytes = lsaBytes(lsa);
  return (bytes[16]! << 8) | bytes[17]!;
}
