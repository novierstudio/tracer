import type { Ipv6InterfaceConfig, Ipv6StaticRoute } from '../../model';
import { iosIpv6, iosIpv6Cidr } from '../../model/ipv6';

// How IPv6 settings print in running-config. Replaying these lines rebuilds the settings.

/** An interface's IPv6 lines, indented: the link-local address, addresses, autoconfig, enable. */
export function ipv6InterfaceLines(config: Ipv6InterfaceConfig | undefined): string[] {
  if (!config) return [];
  return [
    ...(config.linkLocal ? [` ipv6 address ${iosIpv6(config.linkLocal)} link-local`] : []),
    ...config.addresses.map(
      ({ cidr, eui64 }) => ` ipv6 address ${iosIpv6Cidr(cidr)}${eui64 ? ' eui-64' : ''}`,
    ),
    ...(config.autoconfig ? [' ipv6 address autoconfig'] : []),
    ...(config.enabled ? [' ipv6 enable'] : []),
  ];
}

/** `ipv6 route prefix [interface] [next-hop] [distance]`, as IOS writes it. */
export function ipv6RouteLine({ prefix, nextHop, distance }: Ipv6StaticRoute): string {
  const via =
    nextHop.kind === 'interface'
      ? [nextHop.interface]
      : [...(nextHop.interface ? [nextHop.interface] : []), iosIpv6(nextHop.address)];
  const suffix = distance === undefined ? [] : [String(distance)];
  return ['ipv6 route', iosIpv6Cidr(prefix), ...via, ...suffix].join(' ');
}
