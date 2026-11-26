import { EIGRP_UNREACHABLE, type EigrpKValues, type EigrpMetric } from '../../pdu';

/** IOS's K-values: bandwidth and delay count, load and reliability do not. */
export const DEFAULT_K_VALUES: EigrpKValues = [1, 0, 1, 0, 0];

/** The composite metric of a destination EIGRP cannot reach: all ones. */
export const INFINITE_METRIC = 0xffffffff;

/** EIGRP drops a route this many hops away, as `EIGRP maximum hopcount 100` says. */
export const MAX_HOPS = 100;

/** What a link adds to a path: its bandwidth in kbit/s and its delay in tens of microseconds. */
export type Link = { readonly bandwidth: number; readonly delay: number };

/** The metric of a network on one of this router's own interfaces: the interface alone. */
export const connectedMetric = ({ bandwidth, delay }: Link): EigrpMetric => ({
  bandwidth,
  delay,
  hops: 0,
  reliability: 255,
  load: 1,
  mtu: 1500,
});

/** The metric of a route that is gone, as an update, query or reply withdraws it. */
export const unreachableMetric = (metric: EigrpMetric): EigrpMetric => ({
  ...metric,
  delay: EIGRP_UNREACHABLE,
});

export const isUnreachable = (metric: EigrpMetric) =>
  metric.delay >= EIGRP_UNREACHABLE || metric.hops >= MAX_HOPS;

/**
 * A neighbour's path with this router's link to it added, as the receiver of an update does:
 * the slower bandwidth, the delays summed, one more hop.
 */
export function throughLink(metric: EigrpMetric, link: Link): EigrpMetric {
  if (metric.delay >= EIGRP_UNREACHABLE) return metric;
  return {
    bandwidth: Math.min(metric.bandwidth, link.bandwidth),
    delay: Math.min(metric.delay + link.delay, EIGRP_UNREACHABLE - 1),
    hops: metric.hops + 1,
    reliability: metric.reliability,
    load: metric.load,
    mtu: Math.min(metric.mtu, 1500),
  };
}

/**
 * EIGRP's classic composite metric, as IOS computes it in whole numbers:
 *
 *   256 × (K1·BW + K2·BW / (256 − load) + K3·delay) × K5 / (reliability + K4)
 *
 * where BW is 10^7 divided by the path's slowest bandwidth in kbit/s and delay the sum of its
 * delays in tens of microseconds. The last factor applies only when K5 is not 0. With the default
 * K-values it is 256 × (10^7 / bandwidth + delay). A route that is gone, or would overflow 32
 * bits, is INFINITE_METRIC.
 */
export function compositeMetric(metric: EigrpMetric, [k1, k2, k3, k4, k5]: EigrpKValues): number {
  if (isUnreachable(metric) || metric.bandwidth <= 0) return INFINITE_METRIC;
  const bandwidth = Math.floor(10_000_000 / metric.bandwidth);
  let sum = k1 * bandwidth + Math.floor((k2 * bandwidth) / (256 - metric.load)) + k3 * metric.delay;
  if (k5 !== 0) sum = Math.floor((sum * k5) / (metric.reliability + k4));
  return Math.min(sum * 256, INFINITE_METRIC);
}
