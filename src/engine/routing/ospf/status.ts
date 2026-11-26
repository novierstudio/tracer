import type { InterfaceId, Ipv4Address, Ipv4Cidr } from '@/model';
import type { OspfTimers } from '../timers';

/** A neighbour's progress toward a full adjacency, as RFC 2328 names the states. */
export type OspfNeighborState =
  'down' | 'init' | '2way' | 'exstart' | 'exchange' | 'loading' | 'full';

/** What a router is on one of its OSPF interfaces. */
export type OspfInterfaceState =
  | 'loopback'
  /** A new multi-access interface listening before it elects a DR. */
  | 'waiting'
  | 'point-to-point'
  | 'drother'
  | 'backup'
  | 'dr';

/** Ethernet is broadcast, serial is point-to-point, and a loopback is a host route. */
export type OspfNetworkType = 'broadcast' | 'point-to-point' | 'loopback';

/** A router on a multi-access network by its router ID and its address there. */
export type OspfDesignated = { readonly routerId: Ipv4Address; readonly address: Ipv4Address };

/** One neighbour, as `show ip ospf neighbor` lists it. */
export type OspfNeighborStatus = {
  readonly routerId: Ipv4Address;
  readonly priority: number;
  readonly state: OspfNeighborState;
  /** The neighbour's role on a multi-access network. None on a point-to-point link. */
  readonly role: 'dr' | 'bdr' | 'drother' | undefined;
  /** Until the neighbour is declared dead unless another hello arrives. */
  readonly deadMs: number;
  readonly address: Ipv4Address;
  readonly interface: InterfaceId;
};

/** One OSPF interface, as `show ip ospf interface` describes it. */
export type OspfInterfaceStatus = {
  readonly name: InterfaceId;
  readonly cidr: Ipv4Cidr;
  readonly area: number;
  readonly cost: number;
  readonly networkType: OspfNetworkType;
  readonly state: OspfInterfaceState;
  readonly priority: number;
  readonly passive: boolean;
  readonly dr: OspfDesignated | undefined;
  readonly bdr: OspfDesignated | undefined;
  /** Until the next hello. Undefined on a passive interface or a loopback, which send none. */
  readonly helloDueMs: number | undefined;
  readonly neighbors: readonly OspfNeighborStatus[];
};

/** What `show ip protocols` and `show ip ospf` read of a router's OSPF process as it runs. */
export type OspfStatus = {
  readonly processId: number;
  /** Undefined while no interface has an address to take it from: the process cannot start. */
  readonly routerId: Ipv4Address | undefined;
  /** The timers in use, from the lab's routing timer profile. */
  readonly timers: OspfTimers;
  /** In interface order. */
  readonly interfaces: readonly OspfInterfaceStatus[];
  /** The routers whose LSAs gave this router routes, by router ID, with when that LSA arrived. */
  readonly sources: readonly { readonly routerId: Ipv4Address; readonly lastUpdateMs: number }[];
};
