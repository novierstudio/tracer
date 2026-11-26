import type {
  Ipv6AddressEntry,
  Ipv6InterfaceStatus,
  Ipv6NeighborEntry,
  Ipv6Route,
  Ipv6Status,
} from '../../engine/api';
import { INTERFACE_TYPES, type InterfaceId, type InterfaceType } from '../../model';
import {
  ALL_NODES,
  ALL_ROUTERS,
  compareIpv6,
  configuredIpv6Addresses,
  eui64Mac,
  interfaceLinkLocal,
  iosIpv6,
  iosIpv6Cidr,
  ipv6Enabled,
  ipv6Network,
  solicitedNode,
  type Ipv6Address,
} from '../../model/ipv6';
import type { IosDevice } from './context';
import type { PortStates } from './query';
import { ciscoMac, interfaceEntries, interfaceStatus, type InterfaceEntry } from './show';
import { NO_ENGINE } from './showRouting';

/** What the interface commands read: the simulation's answer, or what the config alone says. */
interface InterfaceView {
  readonly routing: boolean;
  readonly interfaces: readonly Ipv6InterfaceStatus[];
  readonly ports: PortStates | undefined;
}

/** All nodes, all routers on a router, then each address's solicited-node group. */
function joinedGroups(routing: boolean, addresses: readonly Ipv6Address[]): Ipv6Address[] {
  return [ALL_NODES, ...(routing ? [ALL_ROUTERS] : []), ...addresses.map(solicitedNode)];
}

/** Each interface with IPv6 enabled, its addresses derived from the config and the MACs. */
function configInterfaces(device: IosDevice, routing: boolean): Ipv6InterfaceStatus[] {
  return interfaceEntries(device).flatMap((entry) => {
    const config = entry.kind === 'switched' ? undefined : entry.config.ipv6;
    const mac = eui64Mac(device.ports, entry.port?.id);
    if (!config || !ipv6Enabled(config) || !mac) return [];
    const linkLocal = interfaceLinkLocal(config, mac);
    const addresses = configuredIpv6Addresses(config, mac).map(
      ({ address, prefixLength, eui64 }): Ipv6AddressEntry => ({
        address,
        prefixLength,
        origin: eui64 ? 'eui64' : 'manual',
      }),
    );
    const own = [linkLocal, ...addresses.map((entry) => entry.address)];
    return [
      {
        name: entry.id,
        up: interfaceStatus(device, entry)[1] === 'up',
        linkLocal,
        addresses,
        groups: joinedGroups(routing, own),
      },
    ];
  });
}

function interfaceView(status: Ipv6Status | undefined, device: IosDevice): InterfaceView {
  if (status) return status;
  const routing = device.kind === 'router' && device.config.ipv6UnicastRouting === true;
  return { routing, interfaces: configInterfaces(device, routing), ports: undefined };
}

const find = (view: InterfaceView, name: InterfaceId) =>
  view.interfaces.find((ipv6) => ipv6.name === name);

/**
 * `show ipv6 interface brief`: every interface and its status, then its link-local and global
 * addresses, or `unassigned` without IPv6.
 */
export function showIpv6InterfaceBrief(
  status: Ipv6Status | undefined,
  device: IosDevice,
): string[] {
  const view = interfaceView(status, device);
  return interfaceEntries(device).flatMap((entry) => {
    const [state, protocol] = interfaceStatus(device, entry, view.ports);
    const ipv6 = find(view, entry.id);
    const addresses = ipv6
      ? [ipv6.linkLocal, ...ipv6.addresses.map(({ address }) => address)].map(iosIpv6)
      : ['unassigned'];
    return [`${entry.id.padEnd(27)}[${state}/${protocol}]`, ...addresses.map((a) => `    ${a}`)];
  });
}

/** IOS's flags after an address: `EUI` from the MAC, `CAL`/`PRE` from SLAAC, `TEN` while down. */
function flags({ origin }: Ipv6AddressEntry, up: boolean): string {
  const all = [
    ...(origin === 'eui64' ? ['EUI'] : origin === 'autoconfig' ? ['EUI', 'CAL', 'PRE'] : []),
    ...(up ? [] : ['TEN']),
  ];
  return all.length === 0 ? '' : ` [${all.join('/')}]`;
}

/** The router advertisement lines: sent on Ethernet, suppressed on serial, absent on a host. */
function advertisementLines(entry: InterfaceEntry, routing: boolean): string[] {
  if (!routing) return [];
  const ethernet = entry.port !== undefined && entry.port.kind !== 'serial';
  return [
    '  ND advertised reachable time is 0 (unspecified)',
    '  ND advertised retransmit interval is 0 (unspecified)',
    ...(ethernet
      ? [
          '  ND router advertisements are sent every 200 seconds',
          '  ND router advertisements live for 1800 seconds',
          '  ND advertised default router preference is Medium',
        ]
      : ['  ND RAs are suppressed (periodic)']),
    '  Hosts use stateless autoconfig for addresses.',
  ];
}

function interfaceDetail(device: IosDevice, entry: InterfaceEntry, view: InterfaceView): string[] {
  const [state, protocol] = interfaceStatus(device, entry, view.ports);
  const head = `${entry.id} is ${state}, line protocol is ${protocol}`;
  const ipv6 = find(view, entry.id);
  if (!ipv6) return [head];
  const { up, linkLocal, addresses } = ipv6;
  const groups = [...new Set(ipv6.groups)].sort(compareIpv6);
  return [
    head,
    `  IPv6 is ${up ? 'enabled' : 'tentative'}, link-local address is ${iosIpv6(linkLocal)}${up ? '' : ' [TEN]'}`,
    '  No Virtual link-local address(es):',
    ...(addresses.length === 0
      ? ['  No global unicast address is configured']
      : [
          '  Global unicast address(es):',
          ...addresses.map((address) => {
            const subnet = { address: ipv6Network(address), prefixLength: address.prefixLength };
            return `    ${iosIpv6(address.address)}, subnet is ${iosIpv6Cidr(subnet)}${flags(address, up)}`;
          }),
        ]),
    '  Joined group address(es):',
    ...groups.map((group) => `    ${iosIpv6(group)}`),
    '  MTU is 1500 bytes',
    '  ICMP error messages limited to one every 100 milliseconds',
    '  ICMP redirects are enabled',
    '  ICMP unreachables are sent',
    '  ND DAD is enabled, number of DAD attempts: 1',
    '  ND reachable time is 30000 milliseconds (using 30000)',
    ...advertisementLines(entry, view.routing),
  ];
}

/**
 * `show ipv6 interface [name]`: the named interface, which without IPv6 prints its status alone,
 * or every interface with IPv6 enabled.
 */
export function showIpv6Interface(
  status: Ipv6Status | undefined,
  device: IosDevice,
  only?: InterfaceId,
): string[] {
  const view = interfaceView(status, device);
  return interfaceEntries(device)
    .filter((entry) => (only === undefined ? find(view, entry.id) : entry.id === only))
    .flatMap((entry) => interfaceDetail(device, entry, view));
}

const ROUTE_LEGEND = [
  'Codes: C - Connected, L - Local, S - Static, R - RIP, B - BGP',
  '       U - Per-user Static route, M - MIPv6',
  '       I1 - ISIS L1, I2 - ISIS L2, IA - ISIS interarea, IS - ISIS summary',
  '       ND - ND Default, NDp - ND Prefix, DCE - Destination, NDr - Redirect',
  '       O - OSPF intra, OI - OSPF inter, OE1 - OSPF ext 1, OE2 - OSPF ext 2',
  '       ON1 - OSPF NSSA ext 1, ON2 - OSPF NSSA ext 2',
  '       D - EIGRP, EX - EIGRP external',
];

const ROUTE_CODE: Readonly<Record<Ipv6Route['source'], string>> = {
  connected: 'C',
  local: 'L',
  static: 'S',
};

function viaLine(route: Ipv6Route): string {
  switch (route.source) {
    case 'connected':
      return `     via ${route.interface}, directly connected`;
    case 'local':
      return `     via ${route.interface}, receive`;
    case 'static': {
      const hop = route.nextHop;
      if (hop.kind === 'interface') return `     via ${hop.interface}, directly connected`;
      const exit = hop.interface === undefined ? '' : `, ${hop.interface}`;
      return `     via ${iosIpv6(hop.address)}${exit}`;
    }
  }
}

/** The multicast route every IOS table ends with. */
const MULTICAST = ['L   FF00::/8 [0/0]', '     via Null0, receive'];

/**
 * `show ipv6 route`: the entry count, the codes legend, then each prefix in the simulation's order
 * with a `via` line per path, and the multicast route last.
 */
export function showIpv6Route(status: Ipv6Status | undefined): readonly string[] {
  if (!status) return NO_ENGINE;
  const entries = new Map<string, Ipv6Route[]>();
  for (const route of status.routes) {
    const key = `${route.source} ${iosIpv6Cidr(route.prefix)}`;
    entries.set(key, [...(entries.get(key) ?? []), route]);
  }
  const lines = [...entries.values()].flatMap((paths) => {
    const [first] = paths as [Ipv6Route, ...Ipv6Route[]];
    const distance = first.source === 'static' ? first.distance : 0;
    const head = `${ROUTE_CODE[first.source].padEnd(4)}${iosIpv6Cidr(first.prefix)} [${distance}/0]`;
    return [head, ...paths.map(viaLine)];
  });
  return [
    `IPv6 Routing Table - ${entries.size + 1} entries`,
    ...ROUTE_LEGEND,
    ...lines,
    ...MULTICAST,
  ];
}

const NEIGHBOR_SHORT: Readonly<Record<InterfaceType, string>> = {
  Loopback: 'Lo',
  FastEthernet: 'Fa',
  GigabitEthernet: 'Gig',
  Serial: 'Se',
  Vlan: 'Vl',
};

/** An interface as `show ipv6 neighbors` abbreviates it: `Gig0/0`, `Fa0/1`, `Se0/0/0`. */
function neighborInterface(id: InterfaceId): string {
  const type = INTERFACE_TYPES.find((name) => id.startsWith(name));
  return type ? NEIGHBOR_SHORT[type] + id.slice(type.length) : id;
}

function neighborLine({ address, ageMs, mac, state, interface: id }: Ipv6NeighborEntry): string {
  const age = String(Math.floor(ageMs / 60_000)).padStart(3);
  const link = ciscoMac(mac).toUpperCase();
  return `${iosIpv6(address).padEnd(42)}${age} ${link.padEnd(16)}${state} ${neighborInterface(id)}`;
}

/** `show ipv6 neighbors`: the neighbor cache, ages in whole minutes. */
export function showIpv6Neighbors(status: Ipv6Status | undefined): readonly string[] {
  if (!status) return NO_ENGINE;
  return [
    'IPv6 Address                              Age Link-layer Addr State Interface',
    ...status.neighbors.map(neighborLine),
  ];
}
