import type { Draft } from 'immer';
import {
  ipv4ToUint32,
  uint32ToIpv4,
  type EigrpConfig,
  type EigrpNetwork,
  type Ipv4Address,
} from '../../model';
import type { ModeOf } from '../modes';
import { iface, ipv4, keyword, num } from '../params';
import { defineCommand } from '../tree';
import { INVALID_INPUT, type DeviceContext } from './context';
import { eachInterface } from './ospf';
import { classfulNetwork } from './rip';
import { findInterface, interfaceEntries } from './show';
import { showIpEigrpInterfaces, showIpEigrpNeighbors, showIpEigrpTopology } from './showEigrp';

const routerCommand = defineCommand<DeviceContext>();

const EXEC = ['user-exec', 'priv-exec'] as const;
const GLOBAL = ['global-config'] as const;
const EIGRP = ['eigrp-config'] as const;
const ANY_IF = ['interface-config', 'subinterface-config'] as const;

const NOTHING: readonly string[] = [];
const INCOMPLETE = '% Incomplete command.';

const showEigrp = [
  keyword('show', 'Show running system information'),
  keyword('ip', 'IP information'),
  keyword('eigrp', 'IP-EIGRP show commands'),
] as const;
const topology = keyword('topology', 'IP-EIGRP Topology Table');
const network = keyword('network', 'Enable routing on an IP network');
const networkAddress = ipv4('address', 'Network number');
const passiveInterface = keyword('passive-interface', 'Suppress routing updates on an interface');
const redistributeStatic = [
  keyword('redistribute', 'Redistribute information from another routing protocol'),
  keyword('static', 'Static routes'),
] as const;
const kValue = (name: 'k1' | 'k2' | 'k3' | 'k4' | 'k5') => num(name, 0, 255, name.toUpperCase());

/**
 * What IOS keeps of a `network` command: without a wildcard the address's classful network,
 * with one the address with its wildcard bits cleared.
 */
function networkEntry(address: Ipv4Address, wildcard?: Ipv4Address): EigrpNetwork | undefined {
  if (wildcard === undefined) {
    const classful = classfulNetwork(address);
    return classful && { address: classful };
  }
  const masked = uint32ToIpv4((ipv4ToUint32(address) & ~ipv4ToUint32(wildcard)) >>> 0);
  return { address: masked, wildcard };
}

const sameNetwork = (a: EigrpNetwork, b: EigrpNetwork) =>
  a.address === b.address && a.wildcard === b.wildcard;

/** The router's EIGRP process. `router eigrp` creates it, so it is there in `eigrp-config` unless undone. */
function eigrpOf(ctx: DeviceContext, mode: ModeOf<'eigrp-config'>): Draft<EigrpConfig> {
  return (ctx.device.config.eigrp ??= {
    asn: mode.asn,
    networks: [],
    passiveInterfaces: [],
    variance: 1,
  });
}

function addNetwork(
  ctx: DeviceContext,
  mode: ModeOf<'eigrp-config'>,
  address: Ipv4Address,
  wildcard?: Ipv4Address,
) {
  const entry = networkEntry(address, wildcard);
  if (!entry) return ctx.reject(INVALID_INPUT);
  const eigrp = eigrpOf(ctx, mode);
  if (!eigrp.networks.some((known) => sameNetwork(known, entry))) eigrp.networks.push(entry);
  return NOTHING;
}

function removeNetwork(
  ctx: DeviceContext,
  mode: ModeOf<'eigrp-config'>,
  address: Ipv4Address | undefined,
  wildcard?: Ipv4Address,
) {
  if (address === undefined) return ctx.reject(INCOMPLETE);
  const entry = networkEntry(address, wildcard);
  if (!entry) return ctx.reject(INVALID_INPUT);
  const eigrp = eigrpOf(ctx, mode);
  eigrp.networks = eigrp.networks.filter((known) => !sameNetwork(known, entry));
  return NOTHING;
}

export const eigrpCommands = [
  routerCommand({
    modes: EXEC,
    path: [...showEigrp, keyword('neighbors', 'IP-EIGRP neighbors')],
    run: (_a, ctx) => ctx.query('protocols', showIpEigrpNeighbors),
  }),
  routerCommand({
    modes: EXEC,
    path: [...showEigrp, keyword('interfaces', 'IP-EIGRP interfaces')],
    run: (_a, ctx) => ctx.query('protocols', showIpEigrpInterfaces),
  }),
  routerCommand({
    modes: EXEC,
    path: [...showEigrp, topology],
    run: (_a, ctx) =>
      ctx.query('protocols', (answer, device) => showIpEigrpTopology(answer, device)),
  }),
  routerCommand({
    modes: EXEC,
    path: [...showEigrp, topology, keyword('all-links', 'Show all links in topology table')],
    run: (_a, ctx) =>
      ctx.query('protocols', (answer, device) => showIpEigrpTopology(answer, device, true)),
  }),
  routerCommand({
    modes: GLOBAL,
    path: [
      keyword('router', 'Enable a routing process'),
      keyword('eigrp', 'Enhanced Interior Gateway Routing Protocol (EIGRP)'),
      num('asn', 1, 65535, 'Autonomous system number'),
    ],
    to: ({ asn }) => ({ kind: 'eigrp-config', asn }),
    run: ({ asn }, ctx) => {
      const { config } = ctx.device;
      if (config.eigrp && config.eigrp.asn !== asn) {
        return ctx.reject(
          `% Tracer runs one EIGRP process per router. Remove router eigrp ${config.eigrp.asn} first.`,
        );
      }
      config.eigrp ??= { asn, networks: [], passiveInterfaces: [], variance: 1 };
      return NOTHING;
    },
    no: ({ asn }, ctx) => {
      if (asn === undefined) return ctx.reject(INCOMPLETE);
      if (ctx.device.config.eigrp?.asn === asn) delete ctx.device.config.eigrp;
      return NOTHING;
    },
  }),
  routerCommand({
    modes: EIGRP,
    path: [network, networkAddress],
    run: ({ address }, ctx, mode) => addNetwork(ctx, mode, address),
    no: ({ address }, ctx, mode) => removeNetwork(ctx, mode, address),
  }),
  routerCommand({
    modes: EIGRP,
    path: [network, networkAddress, ipv4('wildcard', 'EIGRP wild card bits')],
    run: ({ address, wildcard }, ctx, mode) => addNetwork(ctx, mode, address, wildcard),
    no: ({ address, wildcard }, ctx, mode) => removeNetwork(ctx, mode, address, wildcard),
  }),
  routerCommand({
    modes: EIGRP,
    path: [passiveInterface, iface('name', 'Interface name')],
    run: ({ name }, ctx, mode) => {
      if (!findInterface(ctx.device, name)) return ctx.reject(INVALID_INPUT);
      const eigrp = eigrpOf(ctx, mode);
      const passive = new Set([...eigrp.passiveInterfaces, name]);
      eigrp.passiveInterfaces = interfaceEntries(ctx.device)
        .map((entry) => entry.id)
        .filter((id) => passive.has(id));
      return NOTHING;
    },
    no: ({ name }, ctx, mode) => {
      if (name === undefined) return ctx.reject(INCOMPLETE);
      if (!findInterface(ctx.device, name)) return ctx.reject(INVALID_INPUT);
      const eigrp = eigrpOf(ctx, mode);
      eigrp.passiveInterfaces = eigrp.passiveInterfaces.filter((id) => id !== name);
      return NOTHING;
    },
  }),
  routerCommand({
    modes: EIGRP,
    path: [
      keyword('eigrp', 'EIGRP specific commands'),
      keyword('router-id', 'router-id for this EIGRP process'),
      ipv4('id', 'EIGRP Router-ID in IP address format'),
    ],
    run: ({ id }, ctx, mode) => {
      eigrpOf(ctx, mode).routerId = id;
      return NOTHING;
    },
    no: (_a, ctx, mode) => {
      delete eigrpOf(ctx, mode).routerId;
      return NOTHING;
    },
  }),
  routerCommand({
    modes: EIGRP,
    path: [
      keyword('variance', 'Control load balancing variance'),
      num('multiplier', 1, 128, 'Metric variance multiplier'),
    ],
    run: ({ multiplier }, ctx, mode) => {
      eigrpOf(ctx, mode).variance = multiplier;
      return NOTHING;
    },
    no: (_a, ctx, mode) => {
      eigrpOf(ctx, mode).variance = 1;
      return NOTHING;
    },
  }),
  routerCommand({
    modes: EIGRP,
    path: [
      keyword('metric', 'Modify EIGRP routing metrics and parameters'),
      keyword('weights', 'Modify EIGRP metric coefficients'),
      num('tos', 0, 8, 'Type Of Service (Only TOS 0 supported)'),
      kValue('k1'),
      kValue('k2'),
      kValue('k3'),
      kValue('k4'),
      kValue('k5'),
    ],
    run: ({ tos, k1, k2, k3, k4, k5 }, ctx, mode) => {
      if (tos !== 0) return ctx.reject(INVALID_INPUT);
      const eigrp = eigrpOf(ctx, mode);
      const kValues = [k1, k2, k3, k4, k5] as [number, number, number, number, number];
      // IOS's own 1 0 1 0 0 is the default, which the running-config leaves out.
      if (kValues.join(' ') === '1 0 1 0 0') delete eigrp.kValues;
      else eigrp.kValues = kValues;
      return NOTHING;
    },
    no: (_a, ctx, mode) => {
      delete eigrpOf(ctx, mode).kValues;
      return NOTHING;
    },
  }),
  routerCommand({
    modes: EIGRP,
    path: redistributeStatic,
    run: (_a, ctx, mode) => {
      eigrpOf(ctx, mode).redistributeStatic = {};
      return NOTHING;
    },
    no: (_a, ctx, mode) => {
      delete eigrpOf(ctx, mode).redistributeStatic;
      return NOTHING;
    },
  }),
  routerCommand({
    modes: EIGRP,
    path: [
      ...redistributeStatic,
      keyword('metric', 'Metric for redistributed routes'),
      num('bandwidth', 1, 4294967295, 'Bandwidth metric in Kbits per second'),
      num('delay', 0, 4294967295, 'EIGRP delay metric, in 10 microsecond units'),
      num('reliability', 0, 255, 'EIGRP reliability metric where 255 is 100% reliable'),
      num('load', 1, 255, 'EIGRP Effective bandwidth metric (Loading) where 255 is 100% loaded'),
      num('mtu', 1, 65535, 'EIGRP MTU of the path'),
    ],
    run: ({ bandwidth, delay, reliability, load, mtu }, ctx, mode) => {
      const metric = { bandwidth, delay, reliability, load, mtu };
      eigrpOf(ctx, mode).redistributeStatic = { metric };
      return NOTHING;
    },
    no: (_a, ctx, mode) => {
      delete eigrpOf(ctx, mode).redistributeStatic;
      return NOTHING;
    },
  }),
  routerCommand({
    modes: EIGRP,
    path: [keyword('auto-summary', 'Enable automatic network number summarization')],
    // Off by default since IOS 15, and Tracer does not summarize, so only `no` is taken.
    run: (_a, ctx) =>
      ctx.reject('% Tracer does not summarize EIGRP routes: auto-summary stays off, as in IOS 15.'),
    no: () => NOTHING,
  }),
  routerCommand({
    modes: ANY_IF,
    path: [
      keyword('bandwidth', 'Set bandwidth informational parameter'),
      num('kbps', 1, 10_000_000, 'Bandwidth in kilobits'),
    ],
    run: ({ kbps }, ctx, mode) =>
      eachInterface(ctx, mode, (config) => void (config.bandwidth = kbps)),
    no: (_a, ctx, mode) => eachInterface(ctx, mode, (config) => void delete config.bandwidth),
  }),
  routerCommand({
    modes: ANY_IF,
    path: [
      keyword('delay', 'Specify interface throughput delay'),
      num('tens', 1, 16_777_215, 'Throughput delay (tens of microseconds)'),
    ],
    run: ({ tens }, ctx, mode) => eachInterface(ctx, mode, (config) => void (config.delay = tens)),
    no: (_a, ctx, mode) => eachInterface(ctx, mode, (config) => void delete config.delay),
  }),
];
