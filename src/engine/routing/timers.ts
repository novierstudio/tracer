import type { RoutingTimers } from '@/model';

/** RIP's timers, in seconds, as `show ip protocols` prints them. */
export type RipTimers = {
  /** A full update goes out of every RIP interface this often. */
  readonly update: number;
  /** A route not refreshed for this long is invalid: unreachable, and held down. */
  readonly invalid: number;
  /** After a route goes invalid, worse news of it from other neighbours is ignored this long. */
  readonly holddown: number;
  /** A route not refreshed for this long is removed from the database. */
  readonly flush: number;
};

/**
 * RIP's timers by the lab's routing timer profile. `ios` is IOS's 30/180/180/240. `fast` keeps
 * the same order of events at a sixth of the update period and a twelfth of the flush time, so a
 * lost route goes invalid after three missed updates and is gone 5 s later.
 */
export const RIP_TIMERS: Record<RoutingTimers, RipTimers> = {
  ios: { update: 30, invalid: 180, holddown: 180, flush: 240 },
  fast: { update: 5, invalid: 15, holddown: 15, flush: 20 },
};

/** OSPF's interface timers, in seconds, as `show ip ospf interface` prints them. */
export type OspfTimers = {
  /** A hello goes out of every OSPF interface this often. */
  readonly hello: number;
  /** A neighbour not heard from for this long is down. */
  readonly dead: number;
  /** How long a new multi-access interface listens before it elects a DR. */
  readonly wait: number;
  /** An unacknowledged DBD, request or LSA goes again after this long. */
  readonly retransmit: number;
  /** SPF runs this long after the database changes, so a burst of changes costs one run. */
  readonly spfDelay: number;
};

/**
 * OSPF's timers by the lab's routing timer profile. `ios` is IOS's hello 10, dead 40, wait 40,
 * retransmit 5 and a 5 s SPF delay. `fast` keeps dead and wait at four hellos, as IOS does, with a
 * hello every 2 s. The wait outlasts fast spanning tree's 4 s, as IOS's 40 s outlasts its 30 s, so
 * a router behind a switch hears its neighbours before it elects a DR. A point-to-point neighbour
 * is FULL within a hello, a multi-access one after the 8 s wait, and a silent one dead in 8 s.
 */
export const OSPF_TIMERS: Record<RoutingTimers, OspfTimers> = {
  ios: { hello: 10, dead: 40, wait: 40, retransmit: 5, spfDelay: 5 },
  fast: { hello: 2, dead: 8, wait: 8, retransmit: 1, spfDelay: 0 },
};

/** EIGRP's interface timers, in seconds, as `show ip eigrp neighbors` counts the hold time down. */
export type EigrpTimers = {
  /** A hello goes out of every EIGRP interface this often. */
  readonly hello: number;
  /** What hellos tell neighbours to wait: one not heard from for this long is down. */
  readonly hold: number;
};

/**
 * EIGRP's timers by the lab's routing timer profile. `ios` is IOS's hello 5 and hold 15 on a LAN
 * or a T1. `fast` keeps the hold at three hellos, as IOS does, with a hello every 2 s.
 */
export const EIGRP_TIMERS: Record<RoutingTimers, EigrpTimers> = {
  ios: { hello: 5, hold: 15 },
  fast: { hello: 2, hold: 6 },
};
