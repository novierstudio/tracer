import type { InterfaceId, Ipv4Address, Ipv4Cidr, MacAddress, RoutingTimers } from '@/model';
import type { SimTime } from '../../core/time';
import type { IpInterface } from '../../l3/interfaces';
import {
  MAX_AGE,
  type Lsa,
  type LsaHeader,
  type LsaKey,
  type OspfDatabaseDescription,
} from '../../pdu';
import type { OspfInterfaceState, OspfNeighborState, OspfNetworkType } from './status';

/** What hellos say when there is no DR or BDR. */
export const NO_ROUTER = '0.0.0.0' as Ipv4Address;

/** Neighbour states in order: an adjacency forms from exstart on. */
const RANK: Record<OspfNeighborState, number> = {
  down: 0,
  init: 1,
  '2way': 2,
  exstart: 3,
  exchange: 4,
  loading: 5,
  full: 6,
};

export const atLeast = (state: OspfNeighborState, floor: OspfNeighborState) =>
  RANK[state] >= RANK[floor];

export type Neighbor = {
  readonly routerId: Ipv4Address;
  /** Its address on the link, from its hellos. */
  address: Ipv4Address;
  /** The MAC its hellos came from, for unicast on a LAN. */
  mac: MacAddress | undefined;
  priority: number;
  /** The DR and BDR it declares in its hellos, by interface address. */
  dr: Ipv4Address;
  bdr: Ipv4Address;
  state: OspfNeighborState;
  deadAt: SimTime;
  /** Whether this router leads the database exchange with it. */
  master: boolean;
  ddSequence: number;
  /** The last DBD sent to it, sent again on a retransmission or a duplicate. */
  lastDbd: OspfDatabaseDescription | undefined;
  /** Whether this router's DBDs have listed its whole database yet. */
  summarySent: boolean;
  /** LSAs it has that this router lacks or holds an older instance of, by LSA key. */
  readonly requests: Map<string, LsaHeader>;
  /** LSAs flooded to it and not yet acknowledged, by LSA key. */
  readonly unacked: Map<string, Lsa>;
};

/** OSPF on one interface. */
export type Iface = {
  readonly name: InterfaceId;
  /** The working interface it runs on, as the IP stack derives it. */
  ip: IpInterface;
  readonly area: number;
  /** Whether its area is a stub area, which neighbours must agree on. */
  readonly stub: boolean;
  readonly type: OspfNetworkType;
  cost: number;
  priority: number;
  readonly passive: boolean;
  state: OspfInterfaceState;
  /** The DR and BDR on a multi-access network, by interface address, as hellos carry them. */
  dr: Ipv4Address;
  bdr: Ipv4Address;
  /** By router ID. */
  readonly neighbors: Map<Ipv4Address, Neighbor>;
  helloAt: SimTime | undefined;
};

/** An LSA as its originator describes it, before it has an age and a sequence number. */
export type LsaBody = Lsa extends infer Each
  ? Each extends Lsa
    ? Omit<Each, 'age' | 'sequence'>
    : never
  : never;

/** An LSA in the database: its age grows from `age` at `receivedAt`. */
export type Stored = { readonly lsa: Lsa; readonly receivedAt: SimTime };

/**
 * How OSPF learned a route, which it prefers in this order whatever the cost: within an area,
 * from another area, or from outside OSPF at type 1 or type 2 metrics.
 */
export type RouteKind = 'intra' | 'inter' | 'E1' | 'E2';

/** A network SPF reached, and the neighbours to forward through. */
export type SpfRoute = {
  readonly prefix: Ipv4Cidr;
  readonly kind: RouteKind;
  /** The path's cost, or a type 2 external's own metric. */
  readonly cost: number;
  readonly hops: readonly { readonly via: Ipv4Address; readonly interface: InterfaceId }[];
  /** When SPF first found it as it is now, as `show ip route` ages it. */
  readonly since: SimTime;
};

/** An area border or AS boundary router this router has a path to, for `show ip ospf border-routers`. */
export type BorderRouter = {
  readonly routerId: Ipv4Address;
  readonly cost: number;
  readonly hops: SpfRoute['hops'];
  readonly abr: boolean;
  readonly asbr: boolean;
  readonly area: number;
  /** Reached through another area's summary, rather than within the area. */
  readonly inter: boolean;
};

/** A running OSPF process. A new router ID or timer profile starts a new one. */
export type Process = {
  readonly id: number;
  readonly routerId: Ipv4Address;
  /** The `router-id` it started with, so a change to it restarts the process. */
  readonly configuredId: Ipv4Address | undefined;
  readonly timers: RoutingTimers;
  readonly interfaces: Map<InterfaceId, Iface>;
  /** Each area's link state database, by LSA key. */
  readonly areas: Map<number, Map<string, Stored>>;
  routes: Map<string, SpfRoute>;
  /** The routers SPF reached, for the routing information sources. */
  reached: Ipv4Address[];
  borderRouters: BorderRouter[];
  /** Whether it has interfaces in more than one area: the B bit of its router LSAs. */
  abr: boolean;
  /** Whether it redistributes routes into OSPF: the E bit of its router LSAs. */
  asbr: boolean;
  spfPending: boolean;
  /** How many times SPF has run, as `show ip ospf` counts it. */
  spfRuns: number;
  /** The refresh timer fired: the summaries SPF originates go out again too. */
  refreshPending: boolean;
};

export type OspfState = {
  process: Process | undefined;
  nextPacketId: number;
};

export const lsaKey = ({ type, id, advertisingRouter }: LsaKey) =>
  `${type} ${id} ${advertisingRouter}`;

/** The LSA as it is now: aged by the whole seconds since it arrived, up to MAX_AGE. */
export function aged({ lsa, receivedAt }: Stored, now: SimTime): Lsa {
  const age = Math.min(MAX_AGE, lsa.age + Math.floor((now - receivedAt) / 1000));
  return age === lsa.age ? lsa : { ...lsa, age };
}

export const headerOf = ({ type, id, advertisingRouter, age, sequence }: Lsa): LsaHeader => ({
  type,
  id,
  advertisingRouter,
  age,
  sequence,
});

/**
 * Which of two instances of one LSA is newer: the higher sequence number, then one at MaxAge,
 * which is being flushed. Positive when `a` is newer, 0 when they are the same instance.
 */
export function compareInstances(a: LsaHeader, b: LsaHeader): number {
  if (a.sequence !== b.sequence) return a.sequence > b.sequence ? 1 : -1;
  const aFlushed = a.age >= MAX_AGE;
  const bFlushed = b.age >= MAX_AGE;
  return aFlushed === bFlushed ? 0 : aFlushed ? 1 : -1;
}

type Timer =
  | { readonly kind: 'start' | 'spf' | 'refresh' }
  | { readonly kind: 'hello' | 'wait'; readonly iface: InterfaceId }
  | { readonly kind: 'dead' | 'rxmt'; readonly iface: InterfaceId; readonly neighbor: Ipv4Address };

export function timerKey(timer: Timer): string {
  if ('neighbor' in timer) return `ospf ${timer.kind} ${timer.iface} ${timer.neighbor}`;
  if ('iface' in timer) return `ospf ${timer.kind} ${timer.iface}`;
  return `ospf ${timer.kind}`;
}

export function parseTimer(key: string): Timer | undefined {
  const [prefix, kind, iface = '', neighbor = ''] = key.split(' ');
  if (prefix !== 'ospf') return undefined;
  switch (kind) {
    case 'start':
    case 'spf':
    case 'refresh':
      return { kind };
    case 'hello':
    case 'wait':
      return { kind, iface: iface as InterfaceId };
    case 'dead':
    case 'rxmt':
      return { kind, iface: iface as InterfaceId, neighbor: neighbor as Ipv4Address };
    default:
      return undefined;
  }
}
