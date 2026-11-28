import type { VtpStatus } from '../../engine/api';
import {
  afterVlanChange,
  RESERVED_VLANS,
  vtpDigest,
  vtpMode,
  vtpRevision,
  vtpVersion,
  type SwitchConfig,
  type VtpMode,
} from '../../model';
import { choice, keyword, num, word } from '../params';
import { defineCommand } from '../tree';
import type { SwitchContext, SwitchDevice } from './context';
import { ciscoMac } from './show';

/** VTP: the `vtp` global commands, the VLAN database rules they set, and `show vtp`. */

const command = defineCommand<SwitchContext>();

const EXEC = ['user-exec', 'priv-exec'] as const;
const GLOBAL = ['global-config'] as const;

const NOTHING: readonly string[] = [];

export const VTP_CLIENT_REFUSAL =
  'VTP VLAN configuration not allowed when device is in CLIENT mode.';

const globalVtp = keyword('vtp', 'Configure global VTP state');
const showVtp = keyword('vtp', 'VTP information');

const MODE_NAMES: Record<VtpMode, string> = {
  server: 'SERVER',
  client: 'CLIENT',
  transparent: 'TRANSPARENT',
};

export const isVtpClient = (ctx: SwitchContext) => vtpMode(ctx.device.config) === 'client';

/** Counts a change to the switch's VLANs: a server's revision goes up by one. */
export function countVlanChange(ctx: SwitchContext) {
  const vtp = afterVlanChange(ctx.device.config);
  if (vtp) ctx.device.config.vtp = vtp;
}

type VtpEdit = (vtp: NonNullable<SwitchConfig['vtp']>) => void;

/** Edits the VTP settings, dropping them once they are all back to IOS's defaults. */
function editVtp(ctx: SwitchContext, edit: VtpEdit) {
  const vtp = { ...ctx.device.config.vtp };
  edit(vtp);
  if (vtp.revision === 0) delete vtp.revision;
  if (Object.keys(vtp).length === 0) delete ctx.device.config.vtp;
  else ctx.device.config.vtp = vtp;
}

function setMode(ctx: SwitchContext, mode: VtpMode): readonly string[] {
  if (vtpMode(ctx.device.config) === mode) return [`Device mode already VTP ${MODE_NAMES[mode]}.`];
  editVtp(ctx, (vtp) => {
    if (mode === 'server') delete vtp.mode;
    else vtp.mode = mode;
    // A transparent switch takes no part in the domain's revisions.
    if (mode === 'transparent') delete vtp.revision;
  });
  return [`Setting device to VTP ${MODE_NAMES[mode]} mode.`];
}

/** `M-D-YY HH:MM:SS` from VTP's `yymmddhhmmss`: `3-1-93 00:27:41`, or `0-0-00 00:00:00` for never. */
function modifiedAt(stamp: string): string {
  const [yy, mm, dd, hh, mi, ss] = stamp.match(/../g) ?? [];
  return `${Number(mm)}-${Number(dd)}-${yy} ${hh}:${mi}:${ss}`;
}

const digestLines = (digest: Uint8Array) => {
  const bytes = Array.from(
    digest,
    (byte) => `0x${byte.toString(16).padStart(2, '0').toUpperCase()}`,
  );
  return [`${bytes.slice(0, 8).join(' ')} `, `${bytes.slice(8).join(' ')} `];
};

const shortVlanName = (id: string) => id.replace(/^Vlan/, 'Vl');

/** `show vtp status`, as Packet Tracer prints it on a 2960. */
export function showVtpStatus(status: VtpStatus | undefined, device: SwitchDevice): string[] {
  const { config } = device;
  const mode = vtpMode(config);
  const label = (text: string, width: number) => `${text.padEnd(width)}: `;
  const top = (text: string, value: string | number) => `${label(text, 32)}${value}`;
  const feature = (text: string, value: string | number) => `${label(text, 34)}${value}`;
  const mac = device.ports.find((port) => port.kind !== 'serial')?.mac;
  const updater = status?.localUpdater;
  const [digest1 = '', digest2 = ''] = digestLines(vtpDigest(config));
  return [
    top('VTP Version capable', '1 to 2'),
    top('VTP version running', vtpVersion(config)),
    top('VTP Domain Name', config.vtp?.domain ?? ''),
    top('VTP Pruning Mode', 'Disabled'),
    top('VTP Traps Generation', 'Disabled'),
    top('Device ID', mac ? ciscoMac(mac).toUpperCase() : ''),
    `Configuration last modified by ${status?.lastModifiedBy ?? '0.0.0.0'} at ${modifiedAt(status?.lastModifiedAt ?? '000000000000')}`,
    ...(mode === 'server'
      ? [
          updater
            ? `Local updater ID is ${updater.address} on interface ${shortVlanName(updater.interface)} (lowest numbered VLAN interface found)`
            : 'Local updater ID is 0.0.0.0 (no valid interface found)',
        ]
      : []),
    '',
    'Feature VLAN : ',
    '--------------',
    feature('VTP Operating Mode', mode[0]!.toUpperCase() + mode.slice(1)),
    feature('Maximum VLANs supported locally', 255),
    feature('Number of existing VLANs', Object.keys(config.vlans).length + RESERVED_VLANS.length),
    feature('Configuration Revision', mode === 'transparent' ? 0 : vtpRevision(config)),
    feature('MD5 digest', digest1),
    `${' '.repeat(36)}${digest2}`,
  ];
}

export function showVtpPassword(device: SwitchDevice): string[] {
  const password = device.config.vtp?.password;
  return password === undefined
    ? ['The VTP password is not configured.']
    : [`VTP Password: ${password}`];
}

export const vtpCommands = [
  command({
    modes: GLOBAL,
    path: [
      globalVtp,
      keyword('mode', 'Configure VTP device mode'),
      choice('mode', {
        client: 'Set the device to client mode.',
        server: 'Set the device to server mode.',
        transparent: 'Set the device to transparent mode.',
      }),
    ],
    run: ({ mode }, ctx) => setMode(ctx, mode),
    no: (_a, ctx) => setMode(ctx, 'server'),
  }),
  command({
    modes: GLOBAL,
    path: [
      globalVtp,
      keyword('domain', 'Set the name of the VTP administrative domain.'),
      word('domain', 'The ascii name for the VTP administrative domain.'),
    ],
    run: ({ domain }, ctx) => {
      if (domain.length > 32) return ctx.reject('% Domain name too long');
      const before = ctx.device.config.vtp?.domain;
      if (before === domain) return [`Domain name already set to ${domain}.`];
      editVtp(ctx, (vtp) => {
        vtp.domain = domain;
        // A new domain starts its revisions over.
        delete vtp.revision;
      });
      return [`Changing VTP domain name from ${before ?? 'NULL'} to ${domain}`];
    },
  }),
  command({
    modes: GLOBAL,
    path: [
      globalVtp,
      keyword('password', 'Set the password for the VTP administrative domain'),
      word('password', 'The ascii password for the VTP administrative domain.'),
    ],
    run: ({ password }, ctx) => {
      if (password.length > 64) return ctx.reject('% Password too long');
      editVtp(ctx, (vtp) => void (vtp.password = password));
      return [`Setting device VLAN database password to ${password}`];
    },
    no: (_a, ctx) => {
      editVtp(ctx, (vtp) => void delete vtp.password);
      return ['Clearing device VLAN database password.'];
    },
  }),
  command({
    modes: GLOBAL,
    path: [
      globalVtp,
      keyword('version', 'Set the adminstrative domain to VTP version'),
      num('version', 1, 2, 'Set the adminstrative domain VTP version number'),
    ],
    run: ({ version }, ctx) => {
      if (isVtpClient(ctx)) return ctx.reject('Cannot modify version in VTP client mode');
      editVtp(ctx, (vtp) => {
        if (version === 2) vtp.version = 2;
        else delete vtp.version;
      });
      return NOTHING;
    },
    no: (_a, ctx) => {
      if (isVtpClient(ctx)) return ctx.reject('Cannot modify version in VTP client mode');
      editVtp(ctx, (vtp) => void delete vtp.version);
      return NOTHING;
    },
  }),
  command({
    modes: EXEC,
    path: [
      keyword('show', 'Show running system information'),
      showVtp,
      keyword('status', 'VTP domain status'),
    ],
    run: (_a, ctx) => ctx.query('layer2', (status, device) => showVtpStatus(status?.vtp, device)),
  }),
  command({
    modes: EXEC,
    path: [
      keyword('show', 'Show running system information'),
      showVtp,
      keyword('password', 'VTP password'),
    ],
    run: (_a, ctx) => showVtpPassword(ctx.device),
  }),
];
