import type { Draft } from 'immer';
import type { EtherChannelStatus, Layer2Status } from '../../engine/api';
import {
  channelGroupOf,
  channelProtocol,
  DEFAULT_LOAD_BALANCE,
  LoadBalance,
  PortChannelId,
  portChannelId,
  type ChannelMode,
  type InterfaceId,
  type PortChannelInterface,
  type PortId,
  type SwitchedInterface,
} from '../../model';
import type { ModeOf } from '../modes';
import { choice, keyword, num } from '../params';
import { shortInterfaceName } from '../interfaces';
import { defineCommand } from '../tree';
import { INVALID_INPUT, type SwitchContext, type SwitchDevice } from './context';
import { NO_ENGINE } from './showSwitching';

const switchCommand = defineCommand<SwitchContext>();

const EXEC = ['user-exec', 'priv-exec'] as const;
const GLOBAL = ['global-config'] as const;
const IF = ['interface-config'] as const;

const NOTHING: readonly string[] = [];

const show = keyword('show', 'Show running system information');
const etherchannel = keyword('etherchannel', 'EtherChannel information');

export const isPortChannelId = (id: InterfaceId): id is PortChannelId =>
  PortChannelId.safeParse(id).success;

/** The ports configured into a channel group, in hardware order. */
export function membersOf(device: SwitchDevice | Draft<SwitchDevice>, group: number): PortId[] {
  return device.ports
    .filter((port) => device.config.interfaces[port.id]?.channelGroup?.group === group)
    .map((port) => port.id);
}

/** `interface port-channel N`: a switch creates it, with a factory access switchport. */
export function enterPortChannel(ctx: SwitchContext, id: PortChannelId): readonly string[] {
  const { config } = ctx.device;
  config.portChannels ??= {};
  config.portChannels[id] ??= { shutdown: false, switchport: { mode: 'access', vlan: 1 as never } };
  return NOTHING;
}

/** `no interface port-channel N`: the port-channel goes, and its members leave the group. */
export function removePortChannel(ctx: SwitchContext, id: PortChannelId): readonly string[] {
  const { device } = ctx;
  const channels = device.config.portChannels;
  if (!channels?.[id]) return ctx.reject(INVALID_INPUT);
  delete channels[id];
  if (Object.keys(channels).length === 0) delete device.config.portChannels;
  for (const port of membersOf(device, channelGroupOf(id))) {
    delete device.config.interfaces[port]!.channelGroup;
  }
  return NOTHING;
}

/**
 * The switchports a command on a port-channel edits: the port-channel's own, then each member's,
 * as IOS copies a port-channel's settings to its members.
 */
export function portChannelTargets(
  device: Draft<SwitchDevice>,
  id: PortChannelId,
): Draft<SwitchedInterface>[] {
  const own = device.config.portChannels?.[id];
  if (!own) return [];
  const members = membersOf(device, channelGroupOf(id)).flatMap((port) => {
    const config = device.config.interfaces[port];
    return config?.switchport ? [config as Draft<SwitchedInterface>] : [];
  });
  return [own as Draft<PortChannelInterface> as Draft<SwitchedInterface>, ...members];
}

const MODE_HELP: Record<ChannelMode, string> = {
  active: 'Enable LACP unconditionally',
  auto: 'Enable PAgP only if a PAgP device is detected',
  desirable: 'Enable PAgP unconditionally',
  on: 'Enable Etherchannel only',
  passive: 'Enable LACP only if a LACP device is detected',
};

const LOAD_BALANCE_HELP: Record<LoadBalance, string> = {
  'dst-ip': 'Dst IP Addr',
  'dst-mac': 'Dst Mac Addr',
  'src-dst-ip': 'Src XOR Dst IP Addr',
  'src-dst-mac': 'Src XOR Dst Mac Addr',
  'src-ip': 'Src IP Addr',
  'src-mac': 'Src Mac Addr',
};

/**
 * `channel-group N mode M` on each port of the mode. The first member creates the port-channel,
 * which takes its switchport settings. A port cannot join a group whose members negotiate with
 * another protocol.
 */
function joinGroup(
  ctx: SwitchContext,
  mode: ModeOf<'interface-config'>,
  group: number,
  channelMode: ChannelMode,
): readonly string[] {
  const { device } = ctx;
  const out: string[] = [];
  for (const id of mode.interfaces) {
    const config = device.config.interfaces[id as PortId];
    if (!config?.switchport) return ctx.reject(INVALID_INPUT);
    const others = membersOf(device, group).filter((port) => port !== id);
    const theirs = others[0] && device.config.interfaces[others[0]]!.channelGroup!.mode;
    if (theirs !== undefined && channelProtocol(theirs) !== channelProtocol(channelMode)) {
      return ctx.reject(
        `Command rejected (Channel protocol mismatch for interface ${shortInterfaceName(id)} in group ${group}): the interface can not be added to the channel group`,
      );
    }
    config.channelGroup = { group, mode: channelMode };
    const po = portChannelId(group);
    device.config.portChannels ??= {};
    if (!device.config.portChannels[po]) {
      device.config.portChannels[po] = {
        shutdown: false,
        switchport: structuredClone(config.switchport),
        ...(config.modeAccess && { modeAccess: true }),
      };
      out.push(`Creating a port-channel interface Port-channel ${group}`);
    }
  }
  return out;
}

export const etherchannelCommands = [
  switchCommand({
    modes: IF,
    path: [
      keyword('channel-group', 'Etherchannel/port bundling configuration'),
      num('group', 1, 6, 'Channel group number'),
      keyword('mode', 'Etherchannel Mode of the interface'),
      choice('mode', MODE_HELP),
    ],
    run: ({ group, mode: channelMode }, ctx, mode) => joinGroup(ctx, mode, group, channelMode),
    no: (_a, ctx, mode) => {
      for (const id of mode.interfaces) {
        const config = ctx.device.config.interfaces[id as PortId];
        if (!config) return ctx.reject(INVALID_INPUT);
        delete config.channelGroup;
      }
      return NOTHING;
    },
  }),
  switchCommand({
    modes: GLOBAL,
    path: [
      keyword('port-channel', 'EtherChannel configuration'),
      keyword('load-balance', 'Load Balancing method'),
      choice('method', LOAD_BALANCE_HELP),
    ],
    run: ({ method }, ctx) => {
      if (method === DEFAULT_LOAD_BALANCE) delete ctx.device.config.loadBalance;
      else ctx.device.config.loadBalance = method;
      return NOTHING;
    },
    no: (_a, ctx) => {
      delete ctx.device.config.loadBalance;
      return NOTHING;
    },
  }),
  switchCommand({
    modes: EXEC,
    path: [show, etherchannel, keyword('summary', 'One-line summary per channel-group')],
    run: (_a, ctx) => ctx.query('layer2', (status) => showEtherchannelSummary(status)),
  }),
  switchCommand({
    modes: EXEC,
    path: [show, etherchannel, keyword('port-channel', 'Port-channel information')],
    run: (_a, ctx) =>
      ctx.query('layer2', (status, device) => showEtherchannelPortChannel(status, device)),
  }),
  switchCommand({
    modes: EXEC,
    path: [
      show,
      etherchannel,
      keyword('load-balance', 'Load-balance/frame-distribution scheme among ports in port-channel'),
    ],
    run: (_a, ctx) => showEtherchannelLoadBalance(ctx.device),
  }),
];

const SUMMARY_LEGEND = [
  'Flags:  D - down        P - in port-channel',
  '        I - stand-alone s - suspended',
  '        H - Hot-standby (LACP only)',
  '        R - Layer3      S - Layer2',
  '        U - in use      f - failed to allocate aggregator',
  '        u - unsuitable for bundling',
  '        w - waiting to be aggregated',
  '        d - default port',
  '',
  '',
];

const protocolName = (group: EtherChannelStatus) =>
  group.protocol === 'lacp' ? 'LACP' : group.protocol === 'pagp' ? 'PAgP' : '-';

/** `show etherchannel summary`: each group's port-channel, protocol and members, with flags. */
export function showEtherchannelSummary(status: Layer2Status | undefined): readonly string[] {
  if (!status) return NO_ENGINE;
  const groups = status.etherchannels;
  const rows = groups.map((group) => {
    const po = `Po${group.group}(S${group.inUse ? 'U' : 'D'})`;
    const ports = group.members
      .map((member) => `${shortInterfaceName(member.port)}(${member.flag})`)
      .join(' ');
    return `${String(group.group).padEnd(7)}${po.padEnd(14)}${protocolName(group).padStart(8)}   ${ports}`;
  });
  return [
    ...SUMMARY_LEGEND,
    `Number of channel-groups in use: ${groups.length}`,
    `Number of aggregators:           ${groups.length}`,
    '',
    'Group  Port-channel  Protocol    Ports',
    '------+-------------+-----------+----------------------------------------------',
    '',
    ...rows,
  ];
}

/** `0d:00h:05m:12s`, as IOS writes an age. */
function age(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const two = (n: number) => String(n).padStart(2, '0');
  return `${d}d:${two(h)}h:${two(m)}m:${two(s)}s`;
}

const EC_STATE: Record<ChannelMode, string> = {
  on: 'On',
  active: 'Active',
  passive: 'Passive',
  desirable: 'Desirable-Sl',
  auto: 'Automatic-Sl',
};

/** `show etherchannel port-channel`: each group's port-channel and the ports bundled in it. */
export function showEtherchannelPortChannel(
  status: Layer2Status | undefined,
  device: SwitchDevice,
): readonly string[] {
  if (!status) return NO_ENGINE;
  const now = status.clock;
  const out = [
    '                Channel-group listing: ',
    '                ----------------------',
    '',
  ];
  for (const group of status.etherchannels) {
    const bundled = group.members.filter((member) => member.flag === 'P');
    const last = bundled.reduce<(typeof bundled)[number] | undefined>(
      (latest, member) =>
        latest === undefined || (member.bundledAt ?? 0) >= (latest.bundledAt ?? 0)
          ? member
          : latest,
      undefined,
    );
    const protocol = group.protocol === 'lacp' ? 'LACP' : group.protocol === 'pagp' ? 'PAgP' : '-';
    out.push(
      `Group: ${group.group} `,
      '----------',
      '                Port-channels in the group: ',
      '                ---------------------------',
      '',
      `Port-channel: Po${group.group}${group.protocol === 'lacp' ? '    (Primary Aggregator)' : ''}`,
      '',
      '------------',
      '',
      `Age of the Port-channel   = ${age(group.upSince === undefined ? 0 : now - group.upSince)}`,
      `Logical slot/port   = 2/${group.group}          Number of ports = ${bundled.length}`,
      ...(group.protocol === 'lacp'
        ? ['HotStandBy port = null ']
        : ['GC                  = 0x00000000      HotStandBy port = null']),
      `Port state          = Port-channel${group.inUse ? ' Ag-Inuse' : ' Ag-Not-Inuse'} `,
      `Protocol            =   ${protocol}`,
      'Port security       = Disabled',
      '',
    );
    if (bundled.length > 0) {
      out.push(
        'Ports in the Port-channel: ',
        '',
        'Index   Load   Port     EC state        No of bits',
        '------+------+------+------------------+-----------',
        ...bundled.map(
          (member, index) =>
            `  ${String(index).padEnd(6)}${'00'.padEnd(7)}${shortInterfaceName(member.port).padEnd(9)}${EC_STATE[member.mode].padEnd(19)}0`,
        ),
        '',
      );
    }
    if (last) {
      out.push(
        `Time since last port bundled:    ${age(now - (last.bundledAt ?? now))}    ${shortInterfaceName(last.port)}`,
        '',
      );
    }
  }
  void device;
  return out;
}

/** `show etherchannel load-balance`: the hashing scheme `port-channel load-balance` sets. */
export function showEtherchannelLoadBalance(device: SwitchDevice): readonly string[] {
  const method = device.config.loadBalance ?? DEFAULT_LOAD_BALANCE;
  return [
    'EtherChannel Load-Balancing Configuration:',
    `        ${method}`,
    '',
    'EtherChannel Load-Balancing Addresses Used Per-Protocol:',
    `Non-IP: ${describeAddresses(method, false)}`,
    `  IPv4: ${describeAddresses(method, true)}`,
  ];
}

function describeAddresses(method: LoadBalance, ip: boolean): string {
  const field = method.endsWith('ip') && ip ? 'IP address' : 'MAC address';
  if (method.startsWith('src-dst')) return `Source XOR Destination ${field}`;
  return `${method.startsWith('src') ? 'Source' : 'Destination'} ${field}`;
}
