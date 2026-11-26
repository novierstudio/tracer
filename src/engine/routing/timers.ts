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
