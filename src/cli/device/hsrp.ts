import type { Draft } from 'immer';
import type { HsrpGroupStatus, HsrpPeerStatus } from '../../engine/api';
import {
  HSRP_DEFAULT_DECREMENT,
  HSRP_MAX_GROUP,
  hsrpPriority,
  hsrpTimers,
  hsrpVirtualMac,
  type HsrpGroup,
  type HsrpVersion,
  type InterfaceId,
  type Ipv4Address,
  type RoutedInterface,
  type Subinterface,
} from '../../model';
import { ptShortName } from '../interfaces';
import type { ModeOf } from '../modes';
import { iface, ipv4, keyword, num, type Segment } from '../params';
import { defineCommand, type Command } from '../tree';
import { INVALID_INPUT, type DeviceContext, type IosDevice } from './context';
import { ciscoMac, findInterface, interfaceEntries, isLayer2 } from './show';

/** HSRP: the `standby` interface commands and the show commands Packet Tracer prints. */

const command = defineCommand<DeviceContext>();

const EXEC = ['user-exec', 'priv-exec'] as const;
const ANY_IF = ['interface-config', 'subinterface-config'] as const;

type IfMode = ModeOf<(typeof ANY_IF)[number]>;
type Args = Readonly<Record<string, unknown>>;
type Target = Draft<RoutedInterface> | Draft<Subinterface>;

const NOTHING: readonly string[] = [];

const standby = keyword('standby', 'HSRP interface configuration commands');
const groupNumber = num('group', 0, 4095, 'group number');

/**
 * Applies `edit` to each interface of the mode that takes HSRP: a router's routed port or
 * subinterface, or a switch's VLAN interface.
 */
function eachTarget(
  ctx: DeviceContext,
  mode: IfMode,
  edit: (config: Target) => readonly string[] | void,
): readonly string[] {
  const ids = mode.kind === 'interface-config' ? mode.interfaces : [mode.interface];
  const out: string[] = [];
  for (const id of ids) {
    const entry = findInterface(ctx.device, id);
    const takesHsrp =
      entry !== undefined &&
      !isLayer2(entry) &&
      (ctx.device.kind === 'router' || entry.port === undefined);
    if (!takesHsrp) return ctx.reject(INVALID_INPUT);
    const result = edit(entry.config as Target);
    if (result) out.push(...result);
  }
  return out;
}

/** Drops a group with nothing left in it, and the interface's HSRP once no group is left. */
function tidy(config: Target, group: number) {
  const groups = config.standby;
  if (!groups) return;
  if (Object.keys(groups[group] ?? {}).length === 0) delete groups[group];
  if (Object.keys(groups).length === 0) delete config.standby;
}

const versionOf = (config: { standbyVersion?: 2 }): HsrpVersion => config.standbyVersion ?? 1;

/** Edits group `number` (0 when the command names none) on each interface of the mode. */
function editGroup(
  ctx: DeviceContext,
  mode: IfMode,
  number: number | undefined,
  edit: (group: Draft<HsrpGroup>, config: Target) => readonly string[] | void,
): readonly string[] {
  const group = number ?? 0;
  return eachTarget(ctx, mode, (config) => {
    if (group > HSRP_MAX_GROUP[versionOf(config)]) return ctx.reject(INVALID_INPUT);
    const groups = (config.standby ??= {});
    const result = edit((groups[group] ??= {}), config);
    tidy(config, group);
    return result;
  });
}

type Handler = (
  args: Args,
  ctx: DeviceContext,
  group: Draft<HsrpGroup>,
  config: Target,
) => readonly string[] | void;

/** `standby <sub>` and `standby <group> <sub>`, which IOS takes as group 0 and group `<group>`. */
function grouped(sub: readonly Segment[], run: Handler, no: Handler): Command<DeviceContext>[] {
  const wrap =
    (handler: Handler) =>
    (args: Args, ctx: DeviceContext, mode: IfMode): readonly string[] =>
      editGroup(ctx, mode, args.group as number | undefined, (group, config) =>
        handler(args, ctx, group, config),
      );
  return [
    [standby, ...sub],
    [standby, groupNumber, ...sub],
  ].map((path) => command({ modes: ANY_IF, path, run: wrap(run), no: wrap(no) }));
}

function setIp(args: Args, ctx: DeviceContext, group: Draft<HsrpGroup>, config: Target) {
  const address = args.address as Ipv4Address;
  const own = config.ipv4;
  if (own?.address === address) return ctx.reject('% Address cannot equal interface IP address.');
  group.ip = address;
  if (own && !sameSubnet(own.address, address, own.prefixLength)) {
    return ['% Warning: address is not within a subnet on this interface'];
  }
  return NOTHING;
}

const toNumber = (address: string) =>
  address.split('.').reduce((value, octet) => value * 256 + Number(octet), 0);

function sameSubnet(a: string, b: string, prefixLength: number) {
  const size = 2 ** (32 - prefixLength);
  return Math.floor(toNumber(a) / size) === Math.floor(toNumber(b) / size);
}

export const hsrpCommands: Command<DeviceContext>[] = [
  ...grouped(
    [
      keyword('ip', 'Enable HSRP and set the virtual IP address'),
      ipv4('address', 'Virtual IP address'),
    ],
    setIp,
    (_a, _ctx, group) => void delete group.ip,
  ),
  ...grouped(
    [keyword('priority', 'Priority level'), num('priority', 0, 255, 'Priority value')],
    (args, _ctx, group) => {
      const priority = args.priority as number;
      if (priority === 100) delete group.priority;
      else group.priority = priority;
    },
    (_a, _ctx, group) => void delete group.priority,
  ),
  ...grouped(
    [keyword('preempt', 'Overthrow lower priority Active routers')],
    (_a, _ctx, group) => void (group.preempt = true),
    (_a, _ctx, group) => void delete group.preempt,
  ),
  ...grouped(
    [
      keyword('timers', 'Hello and hold timers'),
      num('hello', 1, 254, 'Hello interval in seconds'),
      num('hold', 2, 255, 'Hold time in seconds'),
    ],
    (args, ctx, group) => {
      const hello = args.hello as number;
      const hold = args.hold as number;
      if (hold <= hello) return ctx.reject('% Hold time must be greater than hello time');
      if (hello === 3 && hold === 10) delete group.timers;
      else group.timers = { hello, hold };
    },
    (_a, _ctx, group) => void delete group.timers,
  ),
  ...[
    [keyword('track', 'Priority tracking'), iface('interface', 'Interface to track')],
    [
      keyword('track', 'Priority tracking'),
      iface('interface', 'Interface to track'),
      num('decrement', 1, 255, 'Priority decrement'),
    ],
  ].flatMap((sub) =>
    grouped(
      sub,
      (args, _ctx, group) => {
        const tracked = args.interface as InterfaceId;
        const decrement = args.decrement as number | undefined;
        const others = (group.track ?? []).filter((track) => track.interface !== tracked);
        group.track = [
          ...others,
          {
            interface: tracked,
            ...(decrement !== undefined && decrement !== HSRP_DEFAULT_DECREMENT && { decrement }),
          },
        ];
      },
      (args, _ctx, group) => {
        const tracked = args.interface as InterfaceId | undefined;
        const kept = (group.track ?? []).filter(
          (track) => tracked !== undefined && track.interface !== tracked,
        );
        if (kept.length > 0) group.track = kept;
        else delete group.track;
      },
    ),
  ),
  command({
    modes: ANY_IF,
    path: [standby, keyword('version', 'HSRP version'), num('version', 1, 2, 'Version number')],
    run: ({ version }, ctx, mode) => setVersion(ctx, mode, version === 2 ? 2 : 1),
    no: (_a, ctx, mode) => setVersion(ctx, mode, 1),
  }),
  command({
    modes: EXEC,
    path: [
      keyword('show', 'Show running system information'),
      keyword('standby', 'Hot standby protocol information'),
    ],
    run: (_a, ctx) =>
      ctx.query('standby', (groups, device) => showStandby(groups ?? configOnly(device), device)),
  }),
  command({
    modes: EXEC,
    path: [
      keyword('show', 'Show running system information'),
      keyword('standby', 'Hot standby protocol information'),
      keyword('brief', 'Brief output'),
    ],
    run: (_a, ctx) =>
      ctx.query('standby', (groups, device) =>
        showStandbyBrief(groups ?? configOnly(device), device),
      ),
  }),
];

function setVersion(ctx: DeviceContext, mode: IfMode, version: HsrpVersion): readonly string[] {
  return eachTarget(ctx, mode, (config) => {
    const groups = Object.keys(config.standby ?? {}).map(Number);
    if (groups.some((group) => group > HSRP_MAX_GROUP[version])) {
      return ctx.reject('% Warning: Current config does not permit HSRP version 1.');
    }
    if (version === 2) config.standbyVersion = 2;
    else delete config.standbyVersion;
  });
}

// show standby

/** Every group in the config, all in Init, for a terminal with no simulation to ask. */
function configOnly(device: IosDevice): HsrpGroupStatus[] {
  return interfaceEntries(device).flatMap((entry) => {
    if (isLayer2(entry)) return [];
    return Object.entries(entry.config.standby ?? {}).flatMap(([number, group]) =>
      group
        ? [
            {
              interface: entry.id,
              group: Number(number),
              state: 'init' as const,
              active: undefined,
              standby: undefined,
              priority: hsrpPriority(group),
              tracks: (group.track ?? []).map((track) => ({
                interface: track.interface,
                up: true,
                decrement: track.decrement ?? HSRP_DEFAULT_DECREMENT,
              })),
              nextHelloMs: undefined,
              stateChanges: 0,
              sinceChangeMs: undefined,
            },
          ]
        : [],
    );
  });
}

/** Packet Tracer's short interface name in HSRP output: `Gig0/1`, `Fa0/0`, `Vl10`. */
const shortName = (id: string) => ptShortName(id).replace(/^Vlan/, 'Vl');

const ptMac = (version: HsrpVersion, group: number) =>
  ciscoMac(hsrpVirtualMac(version, group)).toUpperCase();

const STATE_NAMES = {
  init: 'Init',
  listen: 'Listen',
  speak: 'Speak',
  standby: 'Standby',
  active: 'Active',
} as const;

function clock(ms: number): string {
  const total = Math.floor(ms / 1000);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor(total / 60) % 60)}:${pad(total % 60)}`;
}

const INIT_REASONS = {
  'interface-down': 'interface down',
  'no-ip': 'virtual IP not cfgd',
  'wrong-subnet': 'virtual IP in wrong subnet',
} as const;

function groupConfigOf(device: IosDevice, status: HsrpGroupStatus) {
  const entry = findInterface(device, status.interface);
  const config = entry && !isLayer2(entry) ? entry.config : undefined;
  return {
    version: versionOf(config ?? {}),
    group: config?.standby?.[status.group] ?? {},
  };
}

const peerLine = (role: 'Active' | 'Standby', peer: HsrpPeerStatus) =>
  `  ${role} router is ${peer.address}, priority ${peer.priority} (expires in ${Math.floor(peer.expiresInMs / 1000)} sec)`;

export function showStandby(groups: readonly HsrpGroupStatus[], device: IosDevice): string[] {
  return groups.flatMap((status) => {
    const { version, group } = groupConfigOf(device, status);
    const { hello, hold } = hsrpTimers(group);
    const mac = ptMac(version, status.group);
    const init = status.state === 'init';
    const reason = status.initReason ? INIT_REASONS[status.initReason] : 'protocol not cfgd';
    const lines = [
      `${status.interface} - Group ${status.group}${version === 2 ? ' (version 2)' : ''}`,
      `  State is ${STATE_NAMES[status.state]}${init ? ` (${reason})` : ''}`,
      status.sinceChangeMs === undefined
        ? `    ${status.stateChanges} state changes, last state change never`
        : `    ${status.stateChanges} state changes, last state change ${clock(status.sinceChangeMs)}`,
      ...(group.ip ? [`  Virtual IP address is ${group.ip}`] : []),
      `  Active virtual MAC address is ${status.active === undefined ? 'unknown' : mac}`,
      `    Local virtual MAC address is ${mac} (v${version} default)`,
      `  Hello time ${hello} sec, hold time ${hold} sec`,
      ...(status.nextHelloMs === undefined
        ? []
        : [`    Next hello sent in ${(status.nextHelloMs / 1000).toFixed(3)} secs`]),
      `  Preemption ${group.preempt ? 'enabled' : 'disabled'}`,
    ];
    if (status.active === 'local') lines.push('  Active router is local');
    else if (status.active === undefined) lines.push('  Active router is unknown');
    else lines.push(peerLine('Active', status.active), `    MAC address is ${mac}`);
    if (status.standby === 'local') lines.push('  Standby router is local');
    else if (status.standby === undefined) lines.push('  Standby router is unknown');
    else lines.push(peerLine('Standby', status.standby));
    lines.push(`  Priority ${status.priority} (configured ${hsrpPriority(group)})`);
    for (const track of status.tracks) {
      lines.push(
        `    Track interface ${track.interface} state ${track.up ? 'Up' : 'Down'} decrement ${track.decrement}`,
      );
    }
    lines.push(`  Group name is hsrp-${shortName(status.interface)}-${status.group} (default)`);
    return lines;
  });
}

const cell = (peer: 'local' | HsrpPeerStatus | undefined) =>
  peer === undefined ? 'unknown' : peer === 'local' ? 'local' : peer.address;

export function showStandbyBrief(groups: readonly HsrpGroupStatus[], device: IosDevice): string[] {
  const header = [
    '                     P indicates configured to preempt.',
    '                     |',
    'Interface   Grp  Pri P State    Active          Standby         Virtual IP',
  ];
  return [
    ...header,
    ...groups.map((status) => {
      const { group } = groupConfigOf(device, status);
      return [
        shortName(status.interface).padEnd(12),
        String(status.group).padEnd(5),
        String(status.priority).padEnd(4),
        (group.preempt ? 'P' : ' ').padEnd(2),
        STATE_NAMES[status.state].padEnd(9),
        cell(status.active).padEnd(16),
        cell(status.standby).padEnd(16),
        group.ip ?? 'unknown',
      ].join('');
    }),
  ];
}
