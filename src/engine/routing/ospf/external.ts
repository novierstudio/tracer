import type {
  Ipv4Address,
  Ipv4Cidr,
  OspfConfig,
  OspfRedistribution,
  PrefixLength,
  StaticRoute,
} from '@/model';
import { ipInterfaces, routingDevice } from '../../l3/interfaces';
import { classfulLength, inPrefix, networkOf } from '../../l3/ipv4';
import type { OspfContext } from './context';
import { lsaKey, type LsaBody, type Process } from './state';

/** What IOS gives a redistributed route without `metric`. */
const REDISTRIBUTED_METRIC = 20;

/** What IOS gives the default route `default-information originate` advertises. */
const DEFAULT_METRIC = 1;

const DEFAULT_ROUTE: Ipv4Cidr = {
  address: '0.0.0.0' as Ipv4Address,
  prefixLength: 0 as PrefixLength,
};

/**
 * The external LSAs this router originates as an AS boundary router: one for each connected
 * network OSPF does not already run on with `redistribute connected`, each static route that
 * resolves with `redistribute static`, and a default route with `default-information originate`,
 * which needs a default route of its own in the table unless `always`. Without `subnets`, only
 * classful networks are redistributed. Redistributed routes carry tag 0; the default carries the
 * process ID, as IOS tags it.
 */
export function externalsWanted(
  ctx: OspfContext,
  process: Process,
  config: OspfConfig,
): Map<string, LsaBody> {
  const wanted = new Map<string, LsaBody>();
  const device = routingDevice(ctx.device);
  if (!device) return wanted;
  const interfaces = ipInterfaces(device, ctx, undefined);
  const statics = device.config.staticRoutes ?? [];
  const resolves = (hop: StaticRoute['nextHop']) =>
    hop.kind === 'interface'
      ? interfaces.some((iface) => iface.name === hop.interface)
      : interfaces.some((iface) => inPrefix(iface.cidr, hop.address));

  const add = (prefix: Ipv4Cidr, metric: number, metricType: 1 | 2, tag: number) => {
    const lsa: LsaBody = {
      type: 'external',
      id: prefix.address,
      advertisingRouter: process.routerId,
      prefixLength: prefix.prefixLength,
      metricType,
      metric,
      tag,
    };
    wanted.set(lsaKey(lsa), lsa);
  };
  const redistribute = (redistribution: OspfRedistribution, route: Ipv4Cidr) => {
    const prefix = networkOf(route);
    if (prefix.prefixLength === 0) return;
    if (!redistribution.subnets && prefix.prefixLength !== classfulLength(prefix.address)) return;
    const { metric = REDISTRIBUTED_METRIC, metricType = 2 } = redistribution;
    add(prefix, metric, metricType, 0);
  };

  if (config.redistributeConnected) {
    for (const iface of interfaces) {
      if (!process.interfaces.has(iface.name))
        redistribute(config.redistributeConnected, iface.cidr);
    }
  }
  if (config.redistributeStatic) {
    for (const route of statics) {
      if (resolves(route.nextHop)) redistribute(config.redistributeStatic, route.prefix);
    }
  }
  const origin = config.defaultOriginate;
  if (origin) {
    const hasDefault =
      origin.always ||
      statics.some((route) => route.prefix.prefixLength === 0 && resolves(route.nextHop)) ||
      ctx
        .learnedRoutes()
        .some((route) => route.source !== 'ospf' && route.prefix.prefixLength === 0);
    if (hasDefault) {
      add(DEFAULT_ROUTE, origin.metric ?? DEFAULT_METRIC, origin.metricType ?? 2, process.id);
    }
  }
  return wanted;
}
