import type { InterfaceId, Ipv6StaticRoute, MacAddress, PortId } from '@/model';
import type { Ipv6Address, Ipv6Cidr } from '@/model/ipv6';

/** How an interface's global address came to be. */
export type Ipv6AddressOrigin =
  /** `ipv6 address X/len`, or a host's static address. */
  | 'manual'
  /** `ipv6 address X/64 eui-64`: the host bits come from the MAC. */
  | 'eui64'
  /** SLAAC: a router advertised the prefix, and the host bits come from the MAC. */
  | 'autoconfig';

export type Ipv6AddressEntry = Ipv6Cidr & { readonly origin: Ipv6AddressOrigin };

/** One interface with IPv6 enabled, as `show ipv6 interface` reports it. */
export type Ipv6InterfaceStatus = {
  readonly name: InterfaceId;
  /** Whether it sends and receives now: its link is up and it is not shut down. */
  readonly up: boolean;
  readonly linkLocal: Ipv6Address;
  /** Its global addresses: configured ones in the order entered, then SLAAC ones. */
  readonly addresses: readonly Ipv6AddressEntry[];
  /** The multicast groups it listens to: all nodes, all routers on a router, solicited-node. */
  readonly groups: readonly Ipv6Address[];
};

/** One line of the IPv6 routing table, as `show ipv6 route` prints it. */
export type Ipv6Route =
  | { readonly source: 'connected'; readonly prefix: Ipv6Cidr; readonly interface: InterfaceId }
  /** One of the router's own addresses, as a /128. */
  | { readonly source: 'local'; readonly prefix: Ipv6Cidr; readonly interface: InterfaceId }
  | {
      readonly source: 'static';
      readonly prefix: Ipv6Cidr;
      readonly distance: number;
      readonly nextHop: Ipv6StaticRoute['nextHop'];
    };

/** IOS's neighbour states: confirmed reachable within the reachable time, or stale since. */
export type NeighborState = 'REACH' | 'STALE';

export type Ipv6NeighborEntry = {
  readonly address: Ipv6Address;
  readonly mac: MacAddress;
  readonly interface: InterfaceId;
  /** Since the neighbour was last confirmed reachable. IOS prints it in minutes. */
  readonly ageMs: number;
  readonly state: NeighborState;
  /** It said it is a router. */
  readonly router: boolean;
};

/** A device's IPv6 as it runs now, for the show commands, `ipv6config` and the inspector. */
export type Ipv6Status = {
  /** `ipv6 unicast-routing`: the device forwards IPv6 and advertises its prefixes. */
  readonly routing: boolean;
  /** Every interface with IPv6 enabled, up or not, in the device's port order. */
  readonly interfaces: readonly Ipv6InterfaceStatus[];
  readonly routes: readonly Ipv6Route[];
  readonly neighbors: readonly Ipv6NeighborEntry[];
  /** A host's default router: its static gateway, or the router whose advertisement it took. */
  readonly gateway?: Ipv6Address;
  /** Whether each port's link is up, so a show command can report interfaces without IPv6. */
  readonly ports: Readonly<Partial<Record<PortId, boolean>>>;
};
