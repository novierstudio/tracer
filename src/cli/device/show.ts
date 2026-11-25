import {
  formatSubnetMask,
  INTERFACE_TYPES,
  VTY_LINE_COUNT,
  type InterfaceId,
  type InterfaceType,
  type LineConfig,
  type Port,
  type RoutedInterface,
  type StaticRoute,
  type SwitchInterface,
} from '../../model';
import { encodeType7 } from '../passwords';
import type { IosDevice } from './context';

export const IOS_VERSION = '15.1';
export const UNSUPPORTED_MARKER = '! unsupported in Tracer';

export type InterfaceEntry =
  | {
      readonly kind: 'routed';
      readonly id: InterfaceId;
      readonly port: Port | undefined;
      readonly config: RoutedInterface;
    }
  | {
      readonly kind: 'switched';
      readonly id: InterfaceId;
      readonly port: Port;
      readonly config: SwitchInterface;
    };

function typeOf(id: InterfaceId): InterfaceType {
  return INTERFACE_TYPES.find((type) => id.startsWith(type))!;
}

const numberOf = (id: string) => Number(/\d+$/.exec(id)?.[0]);

/** Every interface in running-config order: loopbacks, then ports as the hardware lists them, then VLANs. */
export function interfaceEntries(device: IosDevice): InterfaceEntry[] {
  const virtual = Object.entries(device.config.virtualInterfaces)
    .map(([id, config]): InterfaceEntry => ({
      kind: 'routed',
      id: id as InterfaceId,
      port: undefined,
      config,
    }))
    .sort((a, b) => numberOf(a.id) - numberOf(b.id));
  const physical = device.ports.flatMap((port): InterfaceEntry[] => {
    if (device.kind === 'router') {
      const config = device.config.interfaces[port.id];
      return config ? [{ kind: 'routed', id: port.id, port, config }] : [];
    }
    const config = device.config.interfaces[port.id];
    return config ? [{ kind: 'switched', id: port.id, port, config }] : [];
  });
  return [
    ...virtual.filter((entry) => typeOf(entry.id) === 'Loopback'),
    ...physical,
    ...virtual.filter((entry) => typeOf(entry.id) === 'Vlan'),
  ];
}

export function findInterface(device: IosDevice, id: InterfaceId): InterfaceEntry | undefined {
  return interfaceEntries(device).find((entry) => entry.id === id);
}

function passwordText(device: IosDevice, password: string): string {
  return device.config.servicePasswordEncryption ? `7 ${encodeType7(password)}` : password;
}

function interfaceBlock(entry: InterfaceEntry): string[] {
  const { config } = entry;
  const lines = [`interface ${entry.id}`];
  if (config.description !== undefined) lines.push(` description ${config.description}`);
  if (entry.kind === 'switched') {
    const { switchport } = entry.config;
    const access = switchport.mode === 'access' ? switchport.vlan : switchport.accessVlan;
    if (access !== undefined && access !== 1) lines.push(` switchport access vlan ${access}`);
    if (switchport.nativeVlan !== undefined && switchport.nativeVlan !== 1) {
      lines.push(` switchport trunk native vlan ${switchport.nativeVlan}`);
    }
    if (switchport.mode === 'trunk') lines.push(' switchport mode trunk');
  } else {
    const { ipv4 } = entry.config;
    lines.push(
      ipv4
        ? ` ip address ${ipv4.address} ${formatSubnetMask(ipv4.prefixLength)}`
        : ' no ip address',
    );
  }
  if (config.duplex) lines.push(` duplex ${config.duplex}`);
  if (config.speed) lines.push(` speed ${config.speed}`);
  if (entry.kind === 'routed' && entry.config.clockRate)
    lines.push(` clock rate ${entry.config.clockRate}`);
  if (config.shutdown) lines.push(' shutdown');
  return lines;
}

function routeLine({ prefix, nextHop, distance }: StaticRoute): string {
  const via = nextHop.kind === 'address' ? nextHop.address : nextHop.interface;
  const suffix = distance === undefined ? '' : ` ${distance}`;
  return `ip route ${prefix.address} ${formatSubnetMask(prefix.prefixLength)} ${via}${suffix}`;
}

function lineBody(device: IosDevice, line: LineConfig): string[] {
  const body: string[] = [];
  if (line.password) body.push(` password ${passwordText(device, line.password)}`);
  if (line.login === 'password') body.push(' login');
  if (line.login === 'local') body.push(' login local');
  const { ssh, telnet } = line.transportInput;
  if (!(ssh && telnet)) {
    body.push(` transport input ${ssh ? 'ssh' : telnet ? 'telnet' : 'none'}`);
  }
  return body;
}

function sameLine(a: LineConfig, b: LineConfig): boolean {
  return (
    a.password === b.password &&
    a.login === b.login &&
    a.transportInput.ssh === b.transportInput.ssh &&
    a.transportInput.telnet === b.transportInput.telnet
  );
}

export function blankLine(): LineConfig {
  return { login: 'none', transportInput: { ssh: true, telnet: true } };
}

/**
 * IOS prints vty 0-4 and 5-15 as separate blocks, each split where the config changes. Blocks
 * past 4 that a blank device would have anyway are left out, as IOS does.
 */
function vtyBlocks(device: IosDevice, vty: readonly LineConfig[]): string[] {
  const out: string[] = [];
  for (const [from, to] of [
    [0, 4],
    [5, VTY_LINE_COUNT - 1],
  ] as const) {
    let first = from;
    for (let n = from; n <= to; n++) {
      const line = vty[n]!;
      if (n < to && sameLine(line, vty[n + 1]!)) continue;
      if (from === 0 || !sameLine(line, blankLine())) {
        out.push(
          first === n ? `line vty ${first}` : `line vty ${first} ${n}`,
          ...lineBody(device, line),
        );
      }
      first = n + 1;
    }
  }
  return out;
}

function bannerLines(text: string): string[] {
  return `banner motd ^C${text}^C`.split('\n');
}

/** The running-config, from the first `!` to `end`. Replaying it on a blank device rebuilds the config. */
export function runningConfig(device: IosDevice): string[] {
  const { config } = device;
  const out = ['!', `version ${IOS_VERSION}`];
  out.push(
    config.servicePasswordEncryption
      ? 'service password-encryption'
      : 'no service password-encryption',
  );
  out.push('!', `hostname ${config.hostname}`, '!');
  if (config.enableSecret) out.push(`enable secret 5 ${config.enableSecret}`);
  if (config.enablePassword)
    out.push(`enable password ${passwordText(device, config.enablePassword)}`);
  if (!config.domainLookup) out.push('no ip domain-lookup');
  out.push('!');
  for (const entry of interfaceEntries(device)) out.push(...interfaceBlock(entry), '!');
  if (device.kind === 'router' && device.config.staticRoutes.length > 0) {
    out.push(...device.config.staticRoutes.map(routeLine), '!');
  }
  if (device.kind === 'switch' && device.config.defaultGateway) {
    out.push(`ip default-gateway ${device.config.defaultGateway}`, '!');
  }
  if (config.bannerMotd !== undefined) out.push(...bannerLines(config.bannerMotd), '!');
  out.push('line con 0', ...lineBody(device, config.lines.console), '!');
  if (device.kind === 'router')
    out.push('line aux 0', ...lineBody(device, device.config.lines.aux), '!');
  out.push(...vtyBlocks(device, config.lines.vty), '!');
  if (config.unknownLines.length > 0) out.push(UNSUPPORTED_MARKER, ...config.unknownLines, '!');
  out.push('end');
  return out;
}

const byteCount = (lines: readonly string[]) => lines.reduce((n, line) => n + line.length + 1, 0);

export function showRunningConfig(device: IosDevice): string[] {
  const lines = runningConfig(device);
  return [
    'Building configuration...',
    '',
    `Current configuration : ${byteCount(lines)} bytes`,
    ...lines,
  ];
}

export function showStartupConfig(device: IosDevice): string[] {
  const saved = device.config.startupConfig;
  if (!saved) return ['startup-config is not present'];
  return [`Using ${byteCount(saved)} bytes`, ...saved];
}

const PORT_LABEL: Record<Port['kind'], [singular: string, plural: string]> = {
  fastEthernet: ['FastEthernet interface', 'FastEthernet interfaces'],
  gigabitEthernet: ['Gigabit Ethernet interface', 'Gigabit Ethernet interfaces'],
  serial: ['Serial interface', 'Serial interfaces'],
};

export function showVersion(device: IosDevice): string[] {
  const counts = new Map<Port['kind'], number>();
  for (const port of device.ports) counts.set(port.kind, (counts.get(port.kind) ?? 0) + 1);
  const hardware = [...counts].map(([kind, n]) => `${n} ${PORT_LABEL[kind][n === 1 ? 0 : 1]}`);
  return [
    `Tracer IOS Software, Version ${IOS_VERSION}, RELEASE SOFTWARE`,
    '',
    `${device.config.hostname} uptime is 0 minutes`,
    'System returned to ROM by power-on',
    '',
    `${device.model} (${device.kind}) processor`,
    ...hardware,
    '',
    'Configuration register is 0x2102',
  ];
}

/** Status from config alone: the engine supplies link state later. */
function status(entry: InterfaceEntry): [status: string, protocol: string] {
  return entry.config.shutdown ? ['administratively down', 'down'] : ['up', 'up'];
}

export function showIpInterfaceBrief(device: IosDevice): string[] {
  const row = (cells: readonly string[]) =>
    [
      cells[0]!.padEnd(23),
      cells[1]!.padEnd(16),
      cells[2]!.padEnd(4),
      cells[3]!.padEnd(7),
      cells[4]!.padEnd(22),
      cells[5],
    ]
      .join('')
      .trimEnd();
  return [
    row(['Interface', 'IP-Address', 'OK?', 'Method', 'Status', 'Protocol']),
    ...interfaceEntries(device).map((entry) => {
      const ipv4 = entry.kind === 'routed' ? entry.config.ipv4 : undefined;
      return row([
        entry.id,
        ipv4?.address ?? 'unassigned',
        'YES',
        ipv4 ? 'manual' : 'unset',
        ...status(entry),
      ]);
    }),
  ];
}

interface Hardware {
  readonly name: string;
  readonly bandwidth: number;
  readonly delay: number;
  readonly encapsulation: string;
}

const HARDWARE: Record<InterfaceType, Hardware> = {
  Loopback: { name: 'Loopback', bandwidth: 8000000, delay: 5000, encapsulation: 'LOOPBACK' },
  FastEthernet: { name: 'Lance', bandwidth: 100000, delay: 100, encapsulation: 'ARPA' },
  GigabitEthernet: {
    name: 'CN Gigabit Ethernet',
    bandwidth: 1000000,
    delay: 10,
    encapsulation: 'ARPA',
  },
  Serial: { name: 'HD64570', bandwidth: 1544, delay: 20000, encapsulation: 'HDLC' },
  Vlan: { name: 'CPU Interface', bandwidth: 100000, delay: 10, encapsulation: 'ARPA' },
};

/** `aa:bb:cc:dd:ee:ff` as IOS writes it, `aabb.ccdd.eeff`. */
function ciscoMac(mac: string): string {
  return mac.replace(/:/g, '').match(/.{4}/g)!.join('.');
}

function interfaceDetail(device: IosDevice, entry: InterfaceEntry): string[] {
  const hardware = HARDWARE[typeOf(entry.id)];
  const [state, protocol] = status(entry);
  const macs = device.ports.flatMap((port) => (port.kind === 'serial' ? [] : [port.mac]));
  // A VLAN interface answers with the switch's first Ethernet MAC.
  const mac = entry.port ? (entry.port.kind === 'serial' ? undefined : entry.port.mac) : macs[0];
  const address =
    mac && hardware.encapsulation === 'ARPA'
      ? `, address is ${ciscoMac(mac)} (bia ${ciscoMac(mac)})`
      : '';
  const ipv4 = entry.kind === 'routed' ? entry.config.ipv4 : undefined;
  const bandwidth = entry.config.speed ? entry.config.speed * 1000 : hardware.bandwidth;
  return [
    `${entry.id} is ${state}, line protocol is ${protocol}`,
    `  Hardware is ${hardware.name}${address}`,
    ...(entry.config.description === undefined
      ? []
      : [`  Description: ${entry.config.description}`]),
    ...(ipv4 ? [`  Internet address is ${ipv4.address}/${ipv4.prefixLength}`] : []),
    `  MTU 1500 bytes, BW ${bandwidth} Kbit, DLY ${hardware.delay} usec,`,
    `  Encapsulation ${hardware.encapsulation}, loopback not set`,
  ];
}

export function showInterfaces(device: IosDevice, only?: InterfaceId): string[] | undefined {
  const entries = interfaceEntries(device).filter(
    (entry) => only === undefined || entry.id === only,
  );
  if (only !== undefined && entries.length === 0) return undefined;
  return entries.flatMap((entry) => interfaceDetail(device, entry));
}
