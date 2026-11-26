import type { Draft } from 'immer';
import {
  ipv4ToUint32,
  prefixMask,
  uint32ToIpv4,
  type Ipv4Address,
  type PrefixLength,
  type RipConfig,
} from '../../model';
import { RIP_CONFIG } from '../modes';
import { iface, ipv4, keyword, num } from '../params';
import { defineCommand } from '../tree';
import { INVALID_INPUT, type DeviceContext } from './context';
import { findInterface, interfaceEntries } from './show';
import { showIpProtocols } from './showProtocols';

const routerCommand = defineCommand<DeviceContext>();

const EXEC = ['user-exec', 'priv-exec'] as const;
const GLOBAL = ['global-config'] as const;
const RIP = ['rip-config'] as const;

const NOTHING: readonly string[] = [];
const INCOMPLETE = '% Incomplete command.';

const network = keyword('network', 'Enable routing on an IP network');
const passiveInterface = keyword('passive-interface', 'Suppress routing updates on an interface');
const defaultInformation = keyword(
  'default-information',
  'Control distribution of default information',
);

/** The class A, B or C network an address is in, or undefined for class D and E. */
export function classfulNetwork(address: Ipv4Address): Ipv4Address | undefined {
  const first = Number(address.split('.')[0]);
  if (first >= 224) return undefined;
  const length = (first < 128 ? 8 : first < 192 ? 16 : 24) as PrefixLength;
  return uint32ToIpv4((ipv4ToUint32(address) & prefixMask(length)) >>> 0);
}

/** The router's RIP process. `router rip` creates it, so it is there in `rip-config` unless undone. */
function ripOf(ctx: DeviceContext): Draft<RipConfig> {
  return (ctx.device.config.rip ??= {
    networks: [],
    autoSummary: true,
    passiveInterfaces: [],
    defaultOriginate: false,
  });
}

export const ripCommands = [
  routerCommand({
    modes: EXEC,
    path: [
      keyword('show', 'Show running system information'),
      keyword('ip', 'IP information'),
      keyword('protocols', 'IP routing protocol process parameters and statistics'),
    ],
    run: (_a, ctx) => ctx.query('protocols', showIpProtocols),
  }),
  routerCommand({
    modes: GLOBAL,
    path: [
      keyword('router', 'Enable a routing process'),
      keyword('rip', 'Routing Information Protocol (RIP)'),
    ],
    to: RIP_CONFIG,
    run: (_a, ctx) => {
      ripOf(ctx);
      return NOTHING;
    },
    no: (_a, ctx) => {
      delete ctx.device.config.rip;
      return NOTHING;
    },
  }),
  routerCommand({
    modes: RIP,
    path: [keyword('version', 'Set routing protocol version'), num('version', 1, 2, 'version')],
    run: ({ version }, ctx) => {
      ripOf(ctx).version = version as 1 | 2;
      return NOTHING;
    },
    no: (_a, ctx) => {
      delete ripOf(ctx).version;
      return NOTHING;
    },
  }),
  routerCommand({
    modes: RIP,
    path: [network, ipv4('network', 'Network number')],
    run: ({ network }, ctx) => {
      const classful = classfulNetwork(network);
      if (!classful) return ctx.reject(INVALID_INPUT);
      const rip = ripOf(ctx);
      const networks = new Set([...rip.networks, classful]);
      rip.networks = [...networks].sort((a, b) => ipv4ToUint32(a) - ipv4ToUint32(b));
      return NOTHING;
    },
    no: ({ network }, ctx) => {
      if (network === undefined) return ctx.reject(INCOMPLETE);
      const classful = classfulNetwork(network);
      if (!classful) return ctx.reject(INVALID_INPUT);
      const rip = ripOf(ctx);
      rip.networks = rip.networks.filter((n) => n !== classful);
      return NOTHING;
    },
  }),
  routerCommand({
    modes: RIP,
    path: [keyword('auto-summary', 'Enable automatic network number summarization')],
    run: (_a, ctx) => {
      ripOf(ctx).autoSummary = true;
      return NOTHING;
    },
    no: (_a, ctx) => {
      ripOf(ctx).autoSummary = false;
      return NOTHING;
    },
  }),
  routerCommand({
    modes: RIP,
    path: [passiveInterface, iface('name', 'Interface name')],
    run: ({ name }, ctx) => {
      if (!findInterface(ctx.device, name)) return ctx.reject(INVALID_INPUT);
      const rip = ripOf(ctx);
      const passive = new Set([...rip.passiveInterfaces, name]);
      rip.passiveInterfaces = interfaceEntries(ctx.device)
        .map((entry) => entry.id)
        .filter((id) => passive.has(id));
      return NOTHING;
    },
    no: ({ name }, ctx) => {
      if (name === undefined) return ctx.reject(INCOMPLETE);
      if (!findInterface(ctx.device, name)) return ctx.reject(INVALID_INPUT);
      const rip = ripOf(ctx);
      rip.passiveInterfaces = rip.passiveInterfaces.filter((id) => id !== name);
      return NOTHING;
    },
  }),
  routerCommand({
    modes: RIP,
    path: [defaultInformation, keyword('originate', 'Distribute a default route')],
    run: (_a, ctx) => {
      ripOf(ctx).defaultOriginate = true;
      return NOTHING;
    },
    no: (_a, ctx) => {
      ripOf(ctx).defaultOriginate = false;
      return NOTHING;
    },
  }),
];
