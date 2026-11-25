import type { ArpTableEntry, Route } from '../../engine/api';
import { ipv4ToUint32, prefixMask, uint32ToIpv4, type PrefixLength } from '../../model';
import type { SwitchDevice } from './context';
import { ciscoMac } from './show';

const NO_ENGINE = ['% The simulation is not running, so there is no live state to show.'];

const LEGEND = [
  'Codes: L - local, C - connected, S - static, R - RIP, M - mobile, B - BGP',
  '       D - EIGRP, EX - EIGRP external, O - OSPF, IA - OSPF inter area',
  '       N1 - OSPF NSSA external type 1, N2 - OSPF NSSA external type 2',
  '       E1 - OSPF external type 1, E2 - OSPF external type 2, E - EGP',
  '       i - IS-IS, L1 - IS-IS level-1, L2 - IS-IS level-2, ia - IS-IS inter area',
  '       * - candidate default, U - per-user static route, o - ODR',
  '       P - periodic downloaded static route',
];

const CODE: Record<Route['source'], string> = { connected: 'C', local: 'L', static: 'S' };

/** Where a route's text starts: after the code at the top level, further in under a header. */
const TOP_COLUMN = 6;
const CHILD_COLUMN = 9;

const distanceOf = (route: Route) => (route.source === 'static' ? route.distance : 0);
const prefixText = ({ prefix }: Route) => `${prefix.address}/${prefix.prefixLength}`;

/** The class A, B or C mask length of an address: 8, 16 or 24. */
function classfulLength(address: string): PrefixLength {
  const first = Number(address.split('.')[0]);
  return (first < 128 ? 8 : first < 192 ? 16 : 24) as PrefixLength;
}

function majorNetwork(route: Route): string {
  const length = classfulLength(route.prefix.address);
  const network = (ipv4ToUint32(route.prefix.address) & prefixMask(length)) >>> 0;
  return `${uint32ToIpv4(network)}/${length}`;
}

const isDefault = (route: Route) => route.prefix.prefixLength === 0;

/** The routes IOS installs: for each prefix, those with the lowest administrative distance. */
function installed(routes: readonly Route[]): Route[][] {
  const byPrefix = new Map<string, Route[]>();
  for (const route of routes) {
    // A local route never competes: it is the router's own address, not a way to reach one.
    const key = route.source === 'local' ? `local ${prefixText(route)}` : prefixText(route);
    const same = byPrefix.get(key);
    if (!same) byPrefix.set(key, [route]);
    else if (distanceOf(route) < distanceOf(same[0]!)) byPrefix.set(key, [route]);
    else if (distanceOf(route) === distanceOf(same[0]!)) same.push(route);
  }
  return [...byPrefix.values()];
}

/** What follows the prefix: `is directly connected, Gi0/0` or `[1/0] via 10.0.0.2`. */
function pathText(route: Route): string {
  if (route.source !== 'static') return `is directly connected, ${route.interface}`;
  const hop = route.nextHop;
  return hop.kind === 'interface'
    ? `is directly connected, ${hop.interface}`
    : `[${route.distance}/0] via ${hop.address}`;
}

function routeLines(paths: readonly Route[], column: number): string[] {
  const [first] = paths as [Route, ...Route[]];
  const code = CODE[first.source] + (isDefault(first) && first.source === 'static' ? '*' : '');
  const head = `${code.padEnd(column)}${prefixText(first)} `;
  return paths.map((route, i) => (i === 0 ? head : ' '.repeat(head.length)) + pathText(route));
}

function gatewayLine(routes: readonly Route[][]): string {
  const best = routes.find((paths) => isDefault(paths[0]!) && paths[0]!.source === 'static')?.[0];
  if (best?.source !== 'static') return 'Gateway of last resort is not set';
  const via = best.nextHop.kind === 'address' ? best.nextHop.address : '0.0.0.0';
  return `Gateway of last resort is ${via} to network 0.0.0.0`;
}

/**
 * IOS 15's routing table: the codes legend, the gateway of last resort, then routes by network.
 * Subnets of a classful network sit under a header that counts them; a classful network or a
 * supernet with nothing beside it stands alone.
 */
export function showIpRoute(routes: readonly Route[] | undefined): readonly string[] {
  if (!routes) return NO_ENGINE;
  const table = installed(routes);
  const groups = new Map<string, Route[][]>();
  for (const paths of table) {
    const route = paths[0]!;
    const subnet = route.prefix.prefixLength >= classfulLength(route.prefix.address);
    const key = subnet ? majorNetwork(route) : prefixText(route);
    groups.set(key, [...(groups.get(key) ?? []), paths]);
  }

  const out = [...LEGEND, '', gatewayLine(table), ''];
  for (const [major, members] of groups) {
    const only = members.length === 1 ? members[0]![0]! : undefined;
    if (only && prefixText(only) === major) {
      out.push(...routeLines(members[0]!, TOP_COLUMN));
      continue;
    }
    const masks = new Set(members.map((paths) => paths[0]!.prefix.prefixLength));
    const [network] = major.split('/');
    out.push(
      masks.size === 1
        ? `      ${network}/${[...masks][0]} is subnetted, ${members.length} subnets`
        : `      ${major} is variably subnetted, ${members.length} subnets, ${masks.size} masks`,
    );
    for (const paths of members) out.push(...routeLines(paths, CHILD_COLUMN));
  }
  return out;
}

/** A switch does not route: `show ip route` names its default gateway, as a 2960 does. */
export function showSwitchIpRoute(device: SwitchDevice): readonly string[] {
  const gateway = device.config.defaultGateway;
  return [
    gateway ? `Default gateway is ${gateway}` : 'Default gateway is not set',
    '',
    'Host               Gateway           Last Use    Total Uses  Interface',
    'ICMP redirect cache is empty',
  ];
}

/** `show arp`: the device's own addresses with no age, then what it learned, by address. */
export function showArp(entries: readonly ArpTableEntry[] | undefined): readonly string[] {
  if (!entries) return NO_ENGINE;
  return [
    'Protocol  Address          Age (min)  Hardware Addr   Type   Interface',
    ...entries.map((entry) => {
      const age = entry.kind === 'interface' ? '-' : String(Math.floor(entry.ageMs / 60_000));
      return `Internet  ${entry.address.padEnd(16)}${age.padStart(9)}   ${ciscoMac(entry.mac)}  ARPA   ${entry.interface}`;
    }),
  ];
}
