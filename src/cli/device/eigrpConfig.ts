import type { EigrpConfig, EigrpNetwork } from '../../model';

/** IOS's K-values, which `metric weights` changes. */
export const DEFAULT_K_VALUES = [1, 0, 1, 0, 0] as const;

/** A `network` line's operands: the classful network alone, or an address and its wildcard. */
export const networkText = ({ address, wildcard }: EigrpNetwork) =>
  wildcard === undefined ? address : `${address} ${wildcard}`;

/** `router eigrp` and the settings that differ from its defaults, in Packet Tracer's order. */
export function eigrpLines(eigrp: EigrpConfig): string[] {
  const { kValues, redistributeStatic } = eigrp;
  const metric = redistributeStatic?.metric;
  return [
    `router eigrp ${eigrp.asn}`,
    ...(eigrp.routerId === undefined ? [] : [` eigrp router-id ${eigrp.routerId}`]),
    ...(kValues === undefined ? [] : [` metric weights 0 ${kValues.join(' ')}`]),
    ...(eigrp.variance === 1 ? [] : [` variance ${eigrp.variance}`]),
    ...(redistributeStatic === undefined
      ? []
      : [
          metric
            ? ` redistribute static metric ${metric.bandwidth} ${metric.delay} ${metric.reliability} ${metric.load} ${metric.mtu}`
            : ' redistribute static',
        ]),
    ...eigrp.passiveInterfaces.map((id) => ` passive-interface ${id}`),
    ...eigrp.networks.map((network) => ` network ${networkText(network)}`),
  ];
}
