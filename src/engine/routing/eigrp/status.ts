import type { InterfaceId, Ipv4Address, Ipv4Cidr } from '@/model';
import type { EigrpKValues } from '../../pdu';
import type { EigrpTimers } from '../timers';

/** A neighbour as `show ip eigrp neighbors` lists it. */
export type EigrpNeighborStatus = {
  /** The order neighbours came up in, from 0, as the H column numbers them. */
  readonly handle: number;
  readonly address: Ipv4Address;
  readonly interface: InterfaceId;
  /** Until the neighbour is dropped unless it says hello again. */
  readonly holdMs: number;
  readonly uptimeMs: number;
  /** The sequence number of the last reliable packet it sent. */
  readonly sequence: number;
};

/** One way to a destination, as `show ip eigrp topology` lists it. */
export type EigrpPathStatus =
  /** A network on one of this router's own EIGRP interfaces. */
  | { readonly kind: 'connected'; readonly interface: InterfaceId }
  /** A static route this router redistributes, at the metric it gave it. */
  | { readonly kind: 'redistributed'; readonly distance: number }
  /** Through a neighbour: the distance from here, and the distance the neighbour reported. */
  | {
      readonly kind: 'neighbor';
      readonly via: Ipv4Address;
      readonly interface: InterfaceId;
      readonly distance: number;
      readonly reported: number;
      /** In use: one of the destination's successors. */
      readonly successor: boolean;
      /** Its reported distance is below the feasible distance, so it cannot loop back here. */
      readonly feasible: boolean;
    };

/** A destination in the topology table. */
export type EigrpTopologyEntry = {
  readonly prefix: Ipv4Cidr;
  /** Active while this router waits for its neighbours' replies to a query. */
  readonly state: 'passive' | 'active';
  readonly successors: number;
  /** The feasible distance: the best distance to the destination. INFINITE_METRIC when lost. */
  readonly feasibleDistance: number;
  /** A route redistributed into EIGRP, here or by another router. */
  readonly external: boolean;
  /** Successors first, then the other paths by distance. */
  readonly paths: readonly EigrpPathStatus[];
};

/** What `show ip protocols` and `show ip eigrp` read of a router's EIGRP process as it runs. */
export type EigrpStatus = {
  readonly asn: number;
  /** Undefined until the router has an address to take its ID from. */
  readonly routerId: Ipv4Address | undefined;
  readonly kValues: EigrpKValues;
  readonly timers: EigrpTimers;
  /** The interfaces EIGRP runs on and says hello out of, in interface order. Not passive ones. */
  readonly interfaces: readonly { readonly name: InterfaceId; readonly peers: number }[];
  /** In the order they came up. */
  readonly neighbors: readonly EigrpNeighborStatus[];
  /** By network. */
  readonly topology: readonly EigrpTopologyEntry[];
  /** Each neighbour that sent routes, and when its last update arrived, in ms of simulated time. */
  readonly sources: readonly { readonly gateway: Ipv4Address; readonly lastUpdateAt: number }[];
};
