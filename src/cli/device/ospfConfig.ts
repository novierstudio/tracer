import { formatSubnetMask, type OspfConfig, type OspfRedistribution } from '../../model';

/** What follows `redistribute <source>`, in IOS's order: `metric`, `metric-type`, `subnets`. */
export function redistributionOptions(options: {
  readonly metric?: number;
  readonly metricType?: 1 | 2;
  readonly subnets?: boolean;
}): string {
  return [
    ...(options.metric === undefined ? [] : [` metric ${options.metric}`]),
    // Type 2 is the default, so IOS leaves it out.
    ...(options.metricType === 1 ? [' metric-type 1'] : []),
    ...(options.subnets ? [' subnets'] : []),
  ].join('');
}

const redistributeLine = (source: string, redistribution: OspfRedistribution | undefined) =>
  redistribution ? [` redistribute ${source}${redistributionOptions(redistribution)}`] : [];

/** `router ospf` and its settings, in IOS's order. */
export function ospfLines(ospf: OspfConfig): string[] {
  const origin = ospf.defaultOriginate;
  return [
    `router ospf ${ospf.processId}`,
    ...(ospf.routerId === undefined ? [] : [` router-id ${ospf.routerId}`]),
    ...[...(ospf.areas ?? [])]
      .sort((a, b) => a.area - b.area)
      .flatMap(({ area, stub, ranges = [] }) => [
        ...(stub === undefined
          ? []
          : [` area ${area} stub${stub === 'no-summary' ? ' no-summary' : ''}`]),
        ...ranges.map(
          ({ prefix, advertise }) =>
            ` area ${area} range ${prefix.address} ${formatSubnetMask(prefix.prefixLength)}${advertise ? '' : ' not-advertise'}`,
        ),
      ]),
    ...redistributeLine('connected', ospf.redistributeConnected),
    ...redistributeLine('static', ospf.redistributeStatic),
    ...ospf.passiveInterfaces.map((id) => ` passive-interface ${id}`),
    ...ospf.networks.map(
      ({ address, wildcard, area }) => ` network ${address} ${wildcard} area ${area}`,
    ),
    ...(origin
      ? [
          ` default-information originate${origin.always ? ' always' : ''}${redistributionOptions(origin)}`,
        ]
      : []),
  ];
}
