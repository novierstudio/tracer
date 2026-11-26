// No runtime imports: the simulation worker uses these, and must not pull in zod.
import type { Ipv6InterfaceConfig, Port } from './topology';
import type { Ipv4Address, MacAddress } from './values';

declare const ipv6Brand: unique symbol;

/**
 * An IPv6 address in its canonical text form (RFC 5952): lower case, leading zeros dropped, and
 * the longest run of two or more zero groups written `::`. Two equal addresses are equal strings.
 * IOS prints the same text in upper case: see `iosIpv6`.
 */
export type Ipv6Address = string & { readonly [ipv6Brand]: true };

/** An IPv6 address with a prefix length, 0 to 128: `2001:db8:1::1/64`. */
export type Ipv6Cidr = { readonly address: Ipv6Address; readonly prefixLength: number };

export const IPV6_BITS = 128;

const GROUP = /^[0-9a-f]{1,4}$/i;
const ALL_ONES = (1n << 128n) - 1n;

/** Reads an IPv4 tail, as in `::ffff:10.0.0.1`, as two 16-bit groups. */
function ipv4Groups(text: string): number[] | undefined {
  const octets = text.split('.');
  if (octets.length !== 4) return undefined;
  const bytes = octets.map((octet) => (/^\d{1,3}$/.test(octet) ? Number(octet) : NaN));
  if (bytes.some((byte) => !(byte >= 0 && byte <= 255))) return undefined;
  const [a = 0, b = 0, c = 0, d = 0] = bytes;
  return [(a << 8) | b, (c << 8) | d];
}

function groupsOf(part: string): number[] | undefined {
  if (part === '') return [];
  const words = part.split(':');
  const groups: number[] = [];
  for (const [index, word] of words.entries()) {
    if (index === words.length - 1 && word.includes('.')) {
      const tail = ipv4Groups(word);
      if (!tail) return undefined;
      groups.push(...tail);
    } else if (GROUP.test(word)) {
      groups.push(parseInt(word, 16));
    } else {
      return undefined;
    }
  }
  return groups;
}

/** The eight 16-bit groups of an address in any valid text form, or undefined. */
function parseGroups(text: string): number[] | undefined {
  const halves = text.split('::');
  if (halves.length > 2) return undefined;
  const [head = '', tail] = halves;
  const front = groupsOf(head);
  if (!front) return undefined;
  if (tail === undefined) return front.length === 8 ? front : undefined;
  const back = groupsOf(tail);
  if (!back || front.length + back.length > 7) return undefined;
  return [...front, ...new Array<number>(8 - front.length - back.length).fill(0), ...back];
}

/** The canonical text of eight groups: the first longest run of two or more zeros becomes `::`. */
function formatGroups(groups: readonly number[]): Ipv6Address {
  let bestStart = -1;
  let bestLength = 1;
  for (let start = 0; start < 8;) {
    if (groups[start] !== 0) {
      start++;
      continue;
    }
    let end = start;
    while (end < 8 && groups[end] === 0) end++;
    if (end - start > bestLength) {
      bestStart = start;
      bestLength = end - start;
    }
    start = end;
  }
  const hex = groups.map((group) => group.toString(16));
  if (bestStart < 0) return hex.join(':') as Ipv6Address;
  const head = hex.slice(0, bestStart).join(':');
  const tail = hex.slice(bestStart + bestLength).join(':');
  return `${head}::${tail}` as Ipv6Address;
}

/** Reads an IPv6 address in any valid text form, as its canonical form. Undefined if invalid. */
export function readIpv6(text: string): Ipv6Address | undefined {
  const groups = parseGroups(text.trim());
  return groups && formatGroups(groups);
}

export const isIpv6Text = (text: string) => readIpv6(text) !== undefined;

/** The address as one 128-bit number. */
export function ipv6ToBigInt(address: Ipv6Address): bigint {
  return (parseGroups(address) ?? []).reduce((acc, group) => (acc << 16n) | BigInt(group), 0n);
}

export function bigIntToIpv6(value: bigint): Ipv6Address {
  const groups: number[] = [];
  for (let shift = 112n; shift >= 0n; shift -= 16n) groups.push(Number((value >> shift) & 0xffffn));
  return formatGroups(groups);
}

/** Reads `X:X:X:X::X/<0-128>` as an address and prefix length. The address keeps its host bits. */
export function readIpv6Cidr(text: string): Ipv6Cidr | undefined {
  const [address = '', length, ...rest] = text.trim().split('/');
  if (length === undefined || rest.length > 0 || !/^\d{1,3}$/.test(length)) return undefined;
  const prefixLength = Number(length);
  const parsed = readIpv6(address);
  return parsed && prefixLength <= IPV6_BITS ? { address: parsed, prefixLength } : undefined;
}

const maskOf = (prefixLength: number) =>
  prefixLength === 0 ? 0n : (ALL_ONES << BigInt(IPV6_BITS - prefixLength)) & ALL_ONES;

/** The prefix's network address: its host bits cleared. */
export function ipv6Network({ address, prefixLength }: Ipv6Cidr): Ipv6Address {
  return bigIntToIpv6(ipv6ToBigInt(address) & maskOf(prefixLength));
}

/** The prefix with its host bits cleared, as a routing table lists it. */
export const ipv6Prefix = (cidr: Ipv6Cidr): Ipv6Cidr => ({
  address: ipv6Network(cidr),
  prefixLength: cidr.prefixLength,
});

/** Whether `address` is in the prefix. */
export function inIpv6Prefix(prefix: Ipv6Cidr, address: Ipv6Address): boolean {
  const mask = maskOf(prefix.prefixLength);
  return (ipv6ToBigInt(address) & mask) === (ipv6ToBigInt(prefix.address) & mask);
}

export const formatIpv6Cidr = ({ address, prefixLength }: Ipv6Cidr) => `${address}/${prefixLength}`;

/** The address as IOS and Packet Tracer print it: canonical, in upper case. */
export const iosIpv6 = (address: Ipv6Address) => address.toUpperCase();

/** A prefix as IOS prints it, `2001:DB8:1::/64`. */
export const iosIpv6Cidr = (cidr: Ipv6Cidr) => formatIpv6Cidr(cidr).toUpperCase();

export const UNSPECIFIED_IPV6 = '::' as Ipv6Address;

/** Every node on the link listens to this group. */
export const ALL_NODES = 'ff02::1' as Ipv6Address;

/** Every router on the link listens to this group. Hosts send router solicitations to it. */
export const ALL_ROUTERS = 'ff02::2' as Ipv6Address;

export const LINK_LOCAL_PREFIX: Ipv6Cidr = { address: 'fe80::' as Ipv6Address, prefixLength: 10 };

const MULTICAST_PREFIX: Ipv6Cidr = { address: 'ff00::' as Ipv6Address, prefixLength: 8 };

export const isIpv6Multicast = (address: Ipv6Address) => inIpv6Prefix(MULTICAST_PREFIX, address);

export const isLinkLocal = (address: Ipv6Address) => inIpv6Prefix(LINK_LOCAL_PREFIX, address);

/**
 * The modified EUI-64 interface identifier of a MAC address (RFC 4291): FF:FE in the middle, and
 * the universal/local bit flipped. `00:01:42:5b:2c:1a` gives `201:42ff:fe5b:2c1a`.
 */
export function eui64InterfaceId(mac: MacAddress): bigint {
  const bytes = mac.split(':').map((part) => parseInt(part, 16));
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0] = bytes;
  return [a ^ 0x02, b, c, 0xff, 0xfe, d, e, f].reduce(
    (acc, byte) => (acc << 8n) | BigInt(byte),
    0n,
  );
}

/** The address a /64 prefix and a MAC make by EUI-64, as `ipv6 address X/64 eui-64` and SLAAC do. */
export function eui64Address(prefix: Ipv6Address, mac: MacAddress): Ipv6Address {
  const network = ipv6ToBigInt(prefix) & maskOf(64);
  return bigIntToIpv6(network | eui64InterfaceId(mac));
}

/** The link-local address a MAC makes, FE80:: and its EUI-64 identifier, as IOS derives it. */
export const linkLocalOf = (mac: MacAddress) => eui64Address(LINK_LOCAL_PREFIX.address, mac);

/** The solicited-node group of an address: ff02::1:ff and its last 24 bits (RFC 4291). */
export function solicitedNode(address: Ipv6Address): Ipv6Address {
  const low = ipv6ToBigInt(address) & 0xffffffn;
  return bigIntToIpv6(ipv6ToBigInt('ff02::1:ff00:0' as Ipv6Address) | low);
}

/** The Ethernet address an IPv6 multicast group maps to: 33:33, then the group's last 32 bits. */
export function ipv6MulticastMac(group: Ipv6Address): MacAddress {
  const low = ipv6ToBigInt(group) & 0xffffffffn;
  const bytes = [24n, 16n, 8n, 0n].map((shift) =>
    Number((low >> shift) & 0xffn)
      .toString(16)
      .padStart(2, '0'),
  );
  return ['33', '33', ...bytes].join(':') as MacAddress;
}

export const isIpv6MulticastMac = (mac: MacAddress) => mac.startsWith('33:33:');

/** Orders addresses numerically, as IOS lists them. */
export function compareIpv6(a: Ipv6Address, b: Ipv6Address): number {
  const left = ipv6ToBigInt(a);
  const right = ipv6ToBigInt(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

/** An address of either family, as a ping's target or the source of its replies. */
export type IpAddress = Ipv4Address | Ipv6Address;

/** Whether an address of either family is IPv6. */
export const isIpv6 = (address: IpAddress): address is Ipv6Address => address.includes(':');

/** An address as IOS and Packet Tracer print it: IPv6 in upper case, IPv4 as it is. */
export const iosAddress = (address: IpAddress): string =>
  isIpv6(address) ? iosIpv6(address) : address;

/** Whether IPv6 runs on an interface with these settings: any address, `ipv6 enable` or autoconfig. */
export const ipv6Enabled = (config: Ipv6InterfaceConfig | undefined): boolean =>
  config !== undefined &&
  (config.enabled === true ||
    config.autoconfig === true ||
    config.linkLocal !== undefined ||
    config.addresses.length > 0);

/**
 * The MAC an interface builds its EUI-64 identifiers from: its port's own, or for a serial port, a
 * loopback or anything else without one, the device's first Ethernet port's, as IOS does.
 */
export function eui64Mac(ports: readonly Port[], port?: string): MacAddress | undefined {
  const own = ports.find((candidate) => candidate.id === port);
  if (own && own.kind !== 'serial') return own.mac;
  for (const candidate of ports) if (candidate.kind !== 'serial') return candidate.mac;
  return undefined;
}

/** An interface's link-local address: `ipv6 address X link-local`, else FE80:: and EUI-64. */
export const interfaceLinkLocal = (config: Ipv6InterfaceConfig, mac: MacAddress): Ipv6Address =>
  config.linkLocal ?? linkLocalOf(mac);

/** An interface's configured global addresses, with EUI-64 host bits filled in from `mac`. */
export function configuredIpv6Addresses(
  config: Ipv6InterfaceConfig,
  mac: MacAddress,
): (Ipv6Cidr & { readonly eui64: boolean })[] {
  return config.addresses.map(({ cidr, eui64 }) => ({
    address: eui64 ? eui64Address(cidr.address, mac) : cidr.address,
    prefixLength: cidr.prefixLength,
    eui64,
  }));
}
