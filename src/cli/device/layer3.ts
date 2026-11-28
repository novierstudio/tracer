import type { Draft } from 'immer';
import { isMultilayerSwitch } from '../../devices/catalog';
import { VlanId, type SwitchInterface } from '../../model';
import type { ModeOf } from '../modes';
import { keyword } from '../params';
import { defineCommand, type Command, type Terminal } from '../tree';
import { INVALID_INPUT, type DeviceContext, type SwitchContext } from './context';
import { helperAddressCommands, routeCommands } from './commands';
import { dhcpCommands } from './dhcp';
import { eigrpCommands } from './eigrp';
import { ospfCommands } from './ospf';
import { ripCommands } from './rip';

const switchCommand = defineCommand<SwitchContext>();

const GLOBAL = ['global-config'] as const;
const IF = ['interface-config'] as const;
const NOTHING: readonly string[] = [];
const IP_ROUTING_OFF = '% IP routing not enabled';
const ACCESS_VLAN_1 = { mode: 'access', vlan: VlanId.parse(1) } as const;

const globalIp = keyword('ip', 'Global IP configuration subcommands');
const switchport = keyword('switchport', 'Set switching mode characteristics');

const canRoute = (ctx: DeviceContext) => isMultilayerSwitch(ctx.device.model);

/** A layer 2 switch refuses what only a multilayer switch can do, as IOS on a 2960 does. */
function multilayerOnly<Ctx extends DeviceContext>(command: Command<Ctx>): Command<Ctx> {
  const gate = (terminal: Terminal<Ctx>): Terminal<Ctx> => ({
    ...terminal,
    run: (args, ctx, mode) =>
      canRoute(ctx) ? (terminal.run?.(args, ctx, mode) ?? NOTHING) : ctx.reject(INVALID_INPUT),
  });
  return {
    ...command,
    terminal: gate(command.terminal),
    negation: command.negation && gate(command.negation),
  };
}

/**
 * A multilayer switch opens a routing process (`router ospf`, `router rip`, `router eigrp`) only
 * once `ip routing` is on, as IOS on a 3560 does.
 */
function ipRoutingFirst<Ctx extends DeviceContext>(command: Command<Ctx>): Command<Ctx> {
  const { terminal } = command;
  if (!command.modes.includes('global-config') || !terminal.command.startsWith('router ')) {
    return command;
  }
  return {
    ...command,
    terminal: {
      ...terminal,
      run: (args, ctx, mode) =>
        ctx.device.kind === 'switch' && !ctx.device.config.ipRouting
          ? ctx.reject(IP_ROUTING_OFF)
          : (terminal.run?.(args, ctx, mode) ?? NOTHING),
    },
  };
}

/**
 * Applies `edit` to each physical port of the mode. A VLAN interface or loopback in it refuses
 * the whole command.
 */
function eachPort(
  ctx: SwitchContext,
  mode: ModeOf<'interface-config'>,
  edit: (port: Draft<SwitchInterface>) => void,
): readonly string[] {
  for (const id of mode.interfaces) {
    const port = ctx.device.config.interfaces[id as never];
    if (!port) return ctx.reject(INVALID_INPUT);
    edit(port);
  }
  return NOTHING;
}

/**
 * What a multilayer switch adds to a switch's commands: `ip routing`, routed ports with
 * `no switchport`, static routes, DHCP relay and server, and RIP, OSPF and EIGRP. Those are the
 * router's commands.
 */
export const multilayerCommands = [
  // `switchport` brings a routed port back to switching as a VLAN 1 access port. On a layer 2
  // switch every port switches already, so only `no switchport` needs a multilayer switch.
  switchCommand({
    modes: IF,
    path: [switchport],
    run: (_a, ctx, mode) =>
      eachPort(ctx, mode, (port) => {
        if (port.switchport) return;
        port.switchport = { ...ACCESS_VLAN_1 };
        delete port.ipv4;
        delete port.helperAddresses;
      }),
    no: (_a, ctx, mode) =>
      canRoute(ctx)
        ? eachPort(ctx, mode, (port) => {
            delete port.switchport;
            delete port.portfast;
            delete port.stpCost;
          })
        : ctx.reject(INVALID_INPUT),
  }),
  ...[
    switchCommand({
      modes: GLOBAL,
      path: [globalIp, keyword('routing', 'Enable IP routing')],
      run: (_a, ctx) => {
        ctx.device.config.ipRouting = true;
        return NOTHING;
      },
      no: (_a, ctx) => {
        delete ctx.device.config.ipRouting;
        return NOTHING;
      },
    }),
    ...routeCommands(),
    ...helperAddressCommands(),
    ...dhcpCommands,
    ...ripCommands,
    ...ospfCommands,
    ...eigrpCommands,
  ]
    .map(ipRoutingFirst)
    .map(multilayerOnly),
];
