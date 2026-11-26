import type { Draft } from 'immer';
import type { CdpNeighbor, Layer2Status, LldpNeighbor } from '../../engine/api';
import type { DeviceCapability } from '../../engine/pdu';
import {
  DEFAULT_CDP_HOLDTIME,
  DEFAULT_CDP_TIMER,
  LLDP_HOLDTIME,
  LLDP_TIMER,
  type PortId,
  type RoutedInterface,
  type SwitchInterface,
} from '../../model';
import { ptShortName } from '../interfaces';
import type { ModeOf } from '../modes';
import { iface, keyword, num, word } from '../params';
import { defineCommand } from '../tree';
import { INVALID_INPUT, type DeviceContext, type IosDevice } from './context';
import { securityMac } from './portSecurity';
import { findInterface, interfaceStatus } from './show';

/** CDP and LLDP: the global and interface commands, and the show commands Packet Tracer prints. */

const command = defineCommand<DeviceContext>();

const EXEC = ['user-exec', 'priv-exec'] as const;
const GLOBAL = ['global-config'] as const;
const IF = ['interface-config'] as const;

const NOTHING: readonly string[] = [];

const show = keyword('show', 'Show running system information');
const globalCdp = keyword('cdp', 'Global CDP configuration subcommands');
const interfaceCdp = keyword('cdp', 'CDP interface subcommands');
const showCdp = keyword('cdp', 'CDP information');
const globalLldp = keyword('lldp', 'Global LLDP configuration subcommands');
const interfaceLldp = keyword('lldp', 'LLDP interface subcommands');
const showLldp = keyword('lldp', 'LLDP information');
const detail = keyword('detail', 'Show detailed information');

export const CDP_NOT_ENABLED = '% CDP is not enabled';
export const LLDP_NOT_ENABLED = '% LLDP is not enabled';

type PortConfig = Draft<RoutedInterface> | Draft<SwitchInterface>;

/** Applies `edit` to each port of the mode. CDP and LLDP settings belong to physical ports. */
function eachPort(
  ctx: DeviceContext,
  mode: ModeOf<'interface-config'>,
  edit: (config: PortConfig) => void,
): readonly string[] {
  for (const id of mode.interfaces) {
    const entry = findInterface(ctx.device, id);
    const config = entry?.port && ctx.device.config.interfaces[entry.port.id];
    if (!entry || entry.kind === 'subinterface' || entry.kind === 'port-channel' || !config) {
      return ctx.reject(INVALID_INPUT);
    }
    edit(config);
  }
  return NOTHING;
}

/** A setting that is on by default: the config keeps only `false`. */
type DefaultOn = 'cdpEnable' | 'lldpTransmit' | 'lldpReceive';

const portSwitch = (field: DefaultOn) => ({
  run: (_a: object, ctx: DeviceContext, mode: ModeOf<'interface-config'>) =>
    eachPort(ctx, mode, (config) => void delete config[field]),
  no: (_a: object, ctx: DeviceContext, mode: ModeOf<'interface-config'>) =>
    eachPort(ctx, mode, (config) => void (config[field] = false)),
});

export const discoveryCommands = [
  command({
    modes: GLOBAL,
    path: [globalCdp, keyword('run', 'Enable CDP')],
    run: (_a, ctx) => {
      delete ctx.device.config.cdpRun;
      return NOTHING;
    },
    no: (_a, ctx) => {
      ctx.device.config.cdpRun = false;
      return NOTHING;
    },
  }),
  command({
    modes: GLOBAL,
    path: [
      globalCdp,
      keyword('timer', 'Specify the rate at which CDP packets are sent (in sec)'),
      num('seconds', 5, 254, 'Rate at which CDP packets are sent (in  sec)'),
    ],
    run: ({ seconds }, ctx) => {
      if (seconds === DEFAULT_CDP_TIMER) delete ctx.device.config.cdpTimer;
      else ctx.device.config.cdpTimer = seconds;
      return NOTHING;
    },
    no: (_a, ctx) => {
      delete ctx.device.config.cdpTimer;
      return NOTHING;
    },
  }),
  command({
    modes: GLOBAL,
    path: [
      globalCdp,
      keyword('holdtime', 'Specify the holdtime (in sec) to be sent in packets'),
      num('seconds', 10, 255, 'Length  of time  (in sec) that receiver must keep this packet'),
    ],
    run: ({ seconds }, ctx) => {
      if (seconds === DEFAULT_CDP_HOLDTIME) delete ctx.device.config.cdpHoldtime;
      else ctx.device.config.cdpHoldtime = seconds;
      return NOTHING;
    },
    no: (_a, ctx) => {
      delete ctx.device.config.cdpHoldtime;
      return NOTHING;
    },
  }),
  command({
    modes: GLOBAL,
    path: [globalLldp, keyword('run', 'Enable LLDP')],
    run: (_a, ctx) => {
      ctx.device.config.lldpRun = true;
      return NOTHING;
    },
    no: (_a, ctx) => {
      delete ctx.device.config.lldpRun;
      return NOTHING;
    },
  }),
  command({
    modes: IF,
    path: [interfaceCdp, keyword('enable', 'Enable CDP on interface')],
    ...portSwitch('cdpEnable'),
  }),
  command({
    modes: IF,
    path: [interfaceLldp, keyword('transmit', 'Enable LLDP transmission on interface')],
    ...portSwitch('lldpTransmit'),
  }),
  command({
    modes: IF,
    path: [interfaceLldp, keyword('receive', 'Enable LLDP reception on interface')],
    ...portSwitch('lldpReceive'),
  }),
  command({
    modes: EXEC,
    path: [show, showCdp],
    run: (_a, ctx) => showCdpGlobal(ctx.device),
  }),
  command({
    modes: EXEC,
    path: [show, showCdp, keyword('neighbors', 'CDP neighbor entries')],
    run: (_a, ctx) => ctx.query('layer2', showCdpNeighbors),
  }),
  command({
    modes: EXEC,
    path: [show, showCdp, keyword('neighbors', 'CDP neighbor entries'), detail],
    run: (_a, ctx) =>
      ctx.query('layer2', (status, device) => showCdpEntries(status, device, () => true)),
  }),
  command({
    modes: EXEC,
    path: [show, showCdp, keyword('interface', 'CDP interface status and configuration')],
    run: (_a, ctx) => ctx.query('layer2', (status, device) => showCdpInterface(status, device)),
  }),
  command({
    modes: EXEC,
    path: [
      show,
      showCdp,
      keyword('interface', 'CDP interface status and configuration'),
      iface('name', 'Interface name'),
    ],
    run: ({ name }, ctx) =>
      findInterface(ctx.device, name)
        ? ctx.query('layer2', (status, device) => showCdpInterface(status, device, name as PortId))
        : ctx.reject(INVALID_INPUT),
  }),
  command({
    modes: EXEC,
    path: [
      show,
      showCdp,
      keyword('entry', 'Information for specific neighbor entry'),
      keyword('*', 'all CDP neighbor entries'),
    ],
    run: (_a, ctx) =>
      ctx.query('layer2', (status, device) => showCdpEntries(status, device, () => true)),
  }),
  command({
    modes: EXEC,
    path: [
      show,
      showCdp,
      keyword('entry', 'Information for specific neighbor entry'),
      word('name', 'Name of CDP neighbor entry'),
    ],
    run: ({ name }, ctx) =>
      ctx.query('layer2', (status, device) =>
        showCdpEntries(status, device, (neighbor) => neighbor.deviceId === name),
      ),
  }),
  command({
    modes: EXEC,
    path: [show, showLldp],
    run: (_a, ctx) => showLldpGlobal(ctx.device),
  }),
  command({
    modes: EXEC,
    path: [show, showLldp, keyword('neighbors', 'LLDP neighbor entries')],
    run: (_a, ctx) => ctx.query('layer2', showLldpNeighbors),
  }),
  command({
    modes: EXEC,
    path: [show, showLldp, keyword('neighbors', 'LLDP neighbor entries'), detail],
    run: (_a, ctx) => ctx.query('layer2', showLldpNeighborsDetail),
  }),
];

const cdpRuns = (device: IosDevice) => device.config.cdpRun !== false;
const lldpRuns = (device: IosDevice) => device.config.lldpRun === true;

/** `show cdp`: how often the device advertises, and for how long neighbours keep it. */
export function showCdpGlobal(device: IosDevice): readonly string[] {
  if (!cdpRuns(device)) return [CDP_NOT_ENABLED];
  return [
    'Global CDP information:',
    `    Sending CDP packets every ${device.config.cdpTimer ?? DEFAULT_CDP_TIMER} seconds`,
    `    Sending a holdtime value of ${device.config.cdpHoldtime ?? DEFAULT_CDP_HOLDTIME} seconds`,
    '    Sending CDPv2 advertisements is enabled',
  ];
}

/** `Fas 0/1`, `Gig 0/1`, `Ser 0/0/0`: Packet Tracer's names in `show cdp neighbors`. */
export function cdpShortName(port: string): string {
  return port
    .replace(/^FastEthernet/, 'Fas ')
    .replace(/^GigabitEthernet/, 'Gig ')
    .replace(/^Serial/, 'Ser ');
}

const CDP_LETTER: Record<DeviceCapability, string> = {
  router: 'R',
  switch: 'S',
  host: 'H',
  igmp: 'I',
};

const CDP_WORD: Record<DeviceCapability, string> = {
  router: 'Router',
  switch: 'Switch',
  host: 'Host',
  igmp: 'IGMP',
};

const CDP_LEGEND = [
  'Capability Codes: R - Router, T - Trans Bridge, B - Source Route Bridge',
  '                  S - Switch, H - Host, I - IGMP, r - Repeater, P - Phone',
  'Device ID    Local Intrfce   Holdtme    Capability   Platform    Port ID',
];

/** A Device ID this long takes a line of its own, and the row goes on below it. */
const DEVICE_ID_WRAP = 12;

function cdpRow(neighbor: CdpNeighbor): string[] {
  const capability = neighbor.capabilities.map((c) => CDP_LETTER[c]).join(' ');
  const rest = [
    cdpShortName(neighbor.localPort).padEnd(17),
    String(neighbor.holdtime).padStart(3),
    ' '.repeat(12),
    capability.padEnd(8),
    // A platform name of 12 or more keeps one space before the port.
    `${neighbor.platform.padEnd(11)} `,
    cdpShortName(neighbor.portId),
  ].join('');
  return neighbor.deviceId.length >= DEVICE_ID_WRAP
    ? [neighbor.deviceId, `${' '.repeat(13)}${rest}`]
    : [`${neighbor.deviceId.padEnd(13)}${rest}`];
}

/** `show cdp neighbors`: one row per neighbour, by local port. */
export function showCdpNeighbors(
  status: Layer2Status | undefined,
  device: IosDevice,
): readonly string[] {
  if (!cdpRuns(device)) return [CDP_NOT_ENABLED];
  return [...CDP_LEGEND, ...(status?.cdp.neighbors ?? []).flatMap(cdpRow)];
}

function cdpEntry(neighbor: CdpNeighbor): string[] {
  return [
    '',
    `Device ID: ${neighbor.deviceId}`,
    'Entry address(es): ',
    ...neighbor.addresses.map((address) => `  IP address : ${address}`),
    `Platform: ${neighbor.platform}, Capabilities: ${neighbor.capabilities.map((c) => CDP_WORD[c]).join(' ')}`,
    `Interface: ${neighbor.localPort}, Port ID (outgoing port): ${neighbor.portId}`,
    `Holdtime: ${neighbor.holdtime}`,
    '',
    'Version :',
    neighbor.software,
    '',
    `advertisement version: ${neighbor.version}`,
    `Duplex: ${neighbor.duplex}`,
  ];
}

/** `show cdp neighbors detail` and `show cdp entry`: a block per neighbour `chosen` picks. */
export function showCdpEntries(
  status: Layer2Status | undefined,
  device: IosDevice,
  chosen: (neighbor: CdpNeighbor) => boolean,
): readonly string[] {
  if (!cdpRuns(device)) return [CDP_NOT_ENABLED];
  const blocks = (status?.cdp.neighbors ?? []).filter(chosen).map(cdpEntry);
  return blocks.flatMap((block, i) =>
    i === 0 ? block : ['---------------------------', ...block],
  );
}

/**
 * `show cdp interface [X]`: each port CDP runs on, up or not, with its timers. A port with
 * `no cdp enable` is left out.
 */
export function showCdpInterface(
  status: Layer2Status | undefined,
  device: IosDevice,
  only?: PortId,
): readonly string[] {
  if (!cdpRuns(device)) return [CDP_NOT_ENABLED];
  const timer = device.config.cdpTimer ?? DEFAULT_CDP_TIMER;
  const holdtime = device.config.cdpHoldtime ?? DEFAULT_CDP_HOLDTIME;
  return device.ports
    .filter((port) => (only === undefined || port.id === only) && cdpOn(device, port.id))
    .flatMap((port) => {
      const entry = findInterface(device, port.id);
      if (!entry) return [];
      const [line, protocol] = interfaceStatus(device, entry, status?.ports);
      return [
        `${port.id} is ${line}, line protocol is ${protocol}`,
        `  Sending CDP packets every ${timer} seconds`,
        `  Holdtime is ${holdtime} seconds`,
      ];
    });
}

const cdpOn = (device: IosDevice, port: PortId) =>
  device.config.interfaces[port]?.cdpEnable !== false;

/** `show lldp`: LLDP's fixed timers, while it runs. */
export function showLldpGlobal(device: IosDevice): readonly string[] {
  if (!lldpRuns(device)) return [LLDP_NOT_ENABLED];
  return [
    '',
    'Global LLDP Information:',
    '    Status: ACTIVE',
    `    LLDP advertisements are sent every ${LLDP_TIMER} seconds`,
    `    LLDP hold time advertised is ${LLDP_HOLDTIME} seconds`,
    '    LLDP interface reinitialisation delay is 2 seconds',
  ];
}

/** LLDP's system capabilities: B for bridging, R for routing, in IOS's order. */
const lldpCapabilities = (neighbor: LldpNeighbor) =>
  [
    ...(neighbor.capabilities.includes('switch') ? ['B'] : []),
    ...(neighbor.capabilities.includes('router') ? ['R'] : []),
  ].join(',');

const LLDP_LEGEND = [
  'Capability codes:',
  '    (R) Router, (B) Bridge, (T) Telephone, (C) DOCSIS Cable Device',
  '    (W) WLAN Access Point, (P) Repeater, (S) Station, (O) Other',
  'Device ID           Local Intf     Hold-time  Capability      Port ID',
];

const lldpTotal = (count: number) => ['', `Total entries displayed: ${count}`];

/** `show lldp neighbors`: one row per neighbour, by local port. */
export function showLldpNeighbors(
  status: Layer2Status | undefined,
  device: IosDevice,
): readonly string[] {
  if (!lldpRuns(device)) return [LLDP_NOT_ENABLED];
  const neighbors = status?.lldp.neighbors ?? [];
  const rows = neighbors.map((neighbor) =>
    [
      neighbor.systemName.slice(0, 20).padEnd(20),
      ptShortName(neighbor.localPort).padEnd(15),
      String(neighbor.ttl).padEnd(11),
      lldpCapabilities(neighbor).padEnd(16),
      ptShortName(neighbor.portId),
    ].join(''),
  );
  return [...LLDP_LEGEND, ...rows, ...lldpTotal(neighbors.length)];
}

/** The speeds and duplexes a neighbour's port can run, as Packet Tracer lists them. */
function mediaOf(neighbor: LldpNeighbor): string[] {
  if (neighbor.portId.startsWith('FastEthernet')) {
    return ['10baseT(HD)', '10baseT(FD)', '100baseT(HD)', '100baseT(FD)'];
  }
  return neighbor.capabilities.includes('switch')
    ? ['100baseT(HD)', '100baseT(FD)', '1000baseT(FD)']
    : ['1000baseT(FD)'];
}

const LLDP_RULE = '-'.repeat(48);

function lldpEntry(neighbor: LldpNeighbor): string[] {
  const capabilities = lldpCapabilities(neighbor);
  return [
    LLDP_RULE,
    `Chassis id: ${securityMac(neighbor.chassisId)}`,
    `Port id: ${ptShortName(neighbor.portId)}`,
    `Port Description: ${neighbor.portId}`,
    `System Name: ${neighbor.systemName}`,
    'System Description:',
    neighbor.systemDescription,
    `Time remaining: ${neighbor.holdtime} seconds`,
    `System Capabilities: ${capabilities}`,
    `Enabled Capabilities: ${capabilities}`,
    'Management Addresses - not advertised',
    'Auto Negotiation - supported, enabled',
    'Physical media capabilities:',
    ...mediaOf(neighbor).map((media) => `    ${media}`),
    'Media Attachment Unit type: 10',
    `Vlan ID: ${neighbor.vlan ?? 1}`,
  ];
}

/** `show lldp neighbors detail`: a block per neighbour, each opened by a rule. */
export function showLldpNeighborsDetail(
  status: Layer2Status | undefined,
  device: IosDevice,
): readonly string[] {
  if (!lldpRuns(device)) return [LLDP_NOT_ENABLED];
  const neighbors = status?.lldp.neighbors ?? [];
  return [...neighbors.flatMap(lldpEntry), ...lldpTotal(neighbors.length)];
}
