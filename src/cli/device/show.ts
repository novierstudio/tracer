import {
  carriesVlan,
  isSwitched,
  formatSubnetMask,
  type DhcpPool,
  type DhcpServerConfig,
  formatVlans,
  INTERFACE_TYPES,
  normalizeVlans,
  parentPort,
  VTY_LINE_COUNT,
  type InterfaceId,
  type InterfaceType,
  type LineConfig,
  type OspfConfig,
  type Port,
  type PortChannelId,
  type PortChannelInterface,
  type PortId,
  type PortSecurity,
  type Switchport,
  type RipConfig,
  type RoutedInterface,
  type StaticRoute,
  type Subinterface,
  type SubinterfaceId,
  type SwitchConfig,
  type SwitchedInterface,
  type VlanId,
  type VlanRange,
} from '../../model';
import { encodeType7 } from '../passwords';
import type { IosDevice } from './context';
import type { PortStates } from './query';
import { ipv6InterfaceLines, ipv6RouteLine } from './ipv6Config';
import { sshLines, usernameLines } from './remote';
import { eigrpLines } from './eigrpConfig';
import { accessListLines, natLines } from './showAclNat';

export const IOS_VERSION = '15.1';
export const UNSUPPORTED_MARKER = '! unsupported in Tracer';

export type InterfaceEntry =
  | {
      readonly kind: 'routed';
      readonly id: InterfaceId;
      readonly port: Port | undefined;
      readonly config: RoutedInterface;
      /** A multilayer switch's port taken out of switching with `no switchport`. */
      readonly noSwitchport?: true;
    }
  | {
      readonly kind: 'switched';
      readonly id: InterfaceId;
      readonly port: Port;
      readonly config: SwitchedInterface;
    }
  | {
      /** A switch's `interface Port-channelN`: an EtherChannel's settings, which its members copy. */
      readonly kind: 'port-channel';
      readonly id: PortChannelId;
      readonly port: undefined;
      readonly config: PortChannelInterface;
      /** The ports in its channel group, in hardware order. */
      readonly members: readonly PortId[];
    }
  | {
      readonly kind: 'subinterface';
      readonly id: SubinterfaceId;
      /** The Ethernet port it rides on. */
      readonly port: Port;
      readonly config: Subinterface;
    };

function typeOf(id: InterfaceId): InterfaceType {
  return INTERFACE_TYPES.find((type) => id.startsWith(type))!;
}

const numberOf = (id: string) => Number(/\d+$/.exec(id)?.[0]);

function subinterfacesOf(device: IosDevice, port: Port): InterfaceEntry[] {
  if (device.kind !== 'router') return [];
  return (Object.entries(device.config.subinterfaces) as [SubinterfaceId, Subinterface][])
    .filter(([id]) => parentPort(id) === port.id)
    .sort(([a], [b]) => numberOf(a) - numberOf(b))
    .map(([id, config]) => ({ kind: 'subinterface', id, port, config }));
}

/** Whether an interface switches frames: a switchport, or the port-channel that bundles some. */
export const isLayer2 = (
  entry: InterfaceEntry,
): entry is Extract<InterfaceEntry, { kind: 'switched' | 'port-channel' }> =>
  entry.kind === 'switched' || entry.kind === 'port-channel';

/** A switch's port-channels by number, each with the ports its channel group holds. */
function portChannelsOf(device: IosDevice): InterfaceEntry[] {
  if (device.kind !== 'switch') return [];
  return (
    Object.entries(device.config.portChannels ?? {}) as [PortChannelId, PortChannelInterface][]
  )
    .sort(([a], [b]) => numberOf(a) - numberOf(b))
    .map(([id, config]) => ({
      kind: 'port-channel',
      id,
      port: undefined,
      config,
      members: device.ports
        .filter((port) => device.config.interfaces[port.id]?.channelGroup?.group === numberOf(id))
        .map((port) => port.id),
    }));
}

/**
 * Every interface in running-config order: loopbacks, port-channels, then ports as the hardware
 * lists them, each followed by its subinterfaces, then VLANs.
 */
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
      return config
        ? [{ kind: 'routed', id: port.id, port, config }, ...subinterfacesOf(device, port)]
        : [];
    }
    const config = device.config.interfaces[port.id];
    if (!config) return [];
    // A multilayer switch's routed port lists as a router's port does.
    return isSwitched(config)
      ? [{ kind: 'switched', id: port.id, port, config }]
      : [{ kind: 'routed', id: port.id, port, config, noSwitchport: true }];
  });
  return [
    ...virtual.filter((entry) => typeOf(entry.id) === 'Loopback'),
    ...portChannelsOf(device),
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

/** A switchport's VLAN lines, in IOS's order. */
function switchportLines(switchport: Switchport, modeAccess: boolean | undefined): string[] {
  const lines: string[] = [];
  const access = switchport.mode === 'access' ? switchport.vlan : switchport.accessVlan;
  if (access !== undefined && access !== 1) lines.push(` switchport access vlan ${access}`);
  if (switchport.nativeVlan !== undefined && switchport.nativeVlan !== 1) {
    lines.push(` switchport trunk native vlan ${switchport.nativeVlan}`);
  }
  if (switchport.allowedVlans) {
    lines.push(` switchport trunk allowed vlan ${formatVlans(switchport.allowedVlans)}`);
  }
  if (switchport.mode === 'trunk') lines.push(' switchport mode trunk');
  else if (modeAccess) lines.push(' switchport mode access');
  return lines;
}

/** Port security's lines, in Packet Tracer's order. The settings print even while it is off. */
function portSecurityLines(security: PortSecurity | undefined): string[] {
  if (!security) return [];
  const lines: string[] = [];
  if (security.enabled) lines.push(' switchport port-security');
  if (security.maximum !== undefined) {
    lines.push(` switchport port-security maximum ${security.maximum}`);
  }
  if (security.agingTime !== undefined) {
    lines.push(` switchport port-security aging time ${security.agingTime}`);
  }
  if (security.sticky) lines.push(' switchport port-security mac-address sticky');
  if (security.violation !== undefined && security.violation !== 'shutdown') {
    lines.push(` switchport port-security violation ${security.violation}`);
  }
  // Packet Tracer writes secure addresses in upper case.
  for (const { mac, sticky } of security.addresses) {
    const text = ciscoMac(mac).toUpperCase();
    lines.push(` switchport port-security mac-address ${sticky ? 'sticky ' : ''}${text}`);
  }
  return lines;
}

/** `no cdp enable`, `no lldp transmit` and `no lldp receive`, where an interface has them. */
function discoveryLines(config: {
  cdpEnable?: false;
  lldpTransmit?: false;
  lldpReceive?: false;
}): string[] {
  return [
    ...(config.lldpReceive === false ? [' no lldp receive'] : []),
    ...(config.lldpTransmit === false ? [' no lldp transmit'] : []),
    ...(config.cdpEnable === false ? [' no cdp enable'] : []),
  ];
}

function interfaceBlock(entry: InterfaceEntry): string[] {
  const { config } = entry;
  const lines = [`interface ${entry.id}`];
  if (entry.kind === 'routed' && entry.noSwitchport) lines.push(' no switchport');
  if (config.description !== undefined) lines.push(` description ${config.description}`);
  if (entry.kind === 'port-channel') {
    lines.push(...switchportLines(entry.config.switchport, entry.config.modeAccess));
    if (config.shutdown) lines.push(' shutdown');
    if (entry.config.portfast) lines.push(' spanning-tree portfast');
    if (entry.config.stpCost) lines.push(` spanning-tree cost ${entry.config.stpCost}`);
    return lines;
  }
  if (entry.kind === 'switched') {
    lines.push(...switchportLines(entry.config.switchport, entry.config.modeAccess));
    lines.push(...portSecurityLines(entry.config.portSecurity));
  } else {
    if (entry.kind === 'subinterface' && entry.config.encapsulation) {
      const { vlan, native } = entry.config.encapsulation;
      lines.push(` encapsulation dot1Q ${vlan}${native ? ' native' : ''}`);
    }
    const { ipv4, helperAddresses = [], ospfCost, ospfPriority } = entry.config;
    const { accessGroupIn, accessGroupOut, nat, bandwidth, delay } = entry.config;
    if (bandwidth !== undefined) lines.push(` bandwidth ${bandwidth}`);
    lines.push(
      ipv4
        ? ` ip address ${ipv4.address} ${formatSubnetMask(ipv4.prefixLength)}`
        : ' no ip address',
      ...helperAddresses.map((address) => ` ip helper-address ${address}`),
    );
    if (accessGroupIn !== undefined) lines.push(` ip access-group ${accessGroupIn} in`);
    if (accessGroupOut !== undefined) lines.push(` ip access-group ${accessGroupOut} out`);
    if (nat !== undefined) lines.push(` ip nat ${nat}`);
    if (ospfCost !== undefined) lines.push(` ip ospf cost ${ospfCost}`);
    if (ospfPriority !== undefined) lines.push(` ip ospf priority ${ospfPriority}`);
    if (delay !== undefined) lines.push(` delay ${delay}`);
  }
  if (entry.kind !== 'subinterface') {
    if (entry.config.duplex) lines.push(` duplex ${entry.config.duplex}`);
    if (entry.config.speed) lines.push(` speed ${entry.config.speed}`);
  }
  if (entry.kind !== 'switched') lines.push(...ipv6InterfaceLines(entry.config.ipv6));
  if (entry.kind === 'routed' && entry.config.clockRate)
    lines.push(` clock rate ${entry.config.clockRate}`);
  if (entry.kind !== 'subinterface') lines.push(...discoveryLines(entry.config));
  if (entry.kind === 'switched' && entry.config.channelGroup) {
    const { group, mode } = entry.config.channelGroup;
    lines.push(` channel-group ${group} mode ${mode}`);
  }
  if (config.shutdown) lines.push(' shutdown');
  if (entry.kind === 'switched') {
    if (entry.config.portfast) lines.push(' spanning-tree portfast');
    if (entry.config.stpCost) lines.push(` spanning-tree cost ${entry.config.stpCost}`);
  }
  return lines;
}

/**
 * A switch's global spanning tree lines: the mode, then one line per priority with its VLANs.
 * VLAN keys iterate in ascending order, so the lines follow each priority's lowest VLAN.
 */
function spanningTreeLines(config: SwitchConfig): string[] {
  const byPriority = new Map<number, VlanRange[]>();
  for (const [vlan, priority] of Object.entries(config.stpPriorities ?? {})) {
    const id = Number(vlan) as VlanId;
    byPriority.set(priority, [...(byPriority.get(priority) ?? []), { first: id, last: id }]);
  }
  return [
    'spanning-tree mode pvst',
    'spanning-tree extend system-id',
    ...[...byPriority].map(
      ([priority, vlans]) =>
        `spanning-tree vlan ${formatVlans(normalizeVlans(vlans))} priority ${priority}`,
    ),
  ];
}

/** `errdisable recovery` lines, closed by `!`, when the config has any. */
function errdisableLines(config: SwitchConfig): string[] {
  const recovery = config.errdisableRecovery;
  if (!recovery) return [];
  const lines = [
    ...(recovery.psecureViolation ? ['errdisable recovery cause psecure-violation'] : []),
    ...(recovery.interval === undefined
      ? []
      : [`errdisable recovery interval ${recovery.interval}`]),
  ];
  return lines.length > 0 ? [...lines, '!'] : [];
}

/** CDP and LLDP's global lines where the config differs from IOS's defaults. */
function discoveryGlobalLines(config: IosDevice['config']): string[] {
  return [
    ...(config.cdpTimer === undefined ? [] : [`cdp timer ${config.cdpTimer}`]),
    ...(config.cdpHoldtime === undefined ? [] : [`cdp holdtime ${config.cdpHoldtime}`]),
    ...(config.cdpRun === false ? ['no cdp run'] : []),
    ...(config.lldpRun ? ['lldp run'] : []),
  ];
}

/** `router ospf` and its settings, in IOS's order. */
function ospfBlock(ospf: OspfConfig): string[] {
  return [
    `router ospf ${ospf.processId}`,
    ...(ospf.routerId === undefined ? [] : [` router-id ${ospf.routerId}`]),
    ...ospf.passiveInterfaces.map((id) => ` passive-interface ${id}`),
    ...ospf.networks.map(
      ({ address, wildcard, area }) => ` network ${address} ${wildcard} area ${area}`,
    ),
  ];
}

/** `router rip` and the settings that differ from its defaults, in IOS's order. */
function ripBlock(rip: RipConfig): string[] {
  return [
    'router rip',
    ...(rip.version === undefined ? [] : [` version ${rip.version}`]),
    ...rip.passiveInterfaces.map((id) => ` passive-interface ${id}`),
    ...rip.networks.map((network) => ` network ${network}`),
    ...(rip.defaultOriginate ? [' default-information originate'] : []),
    ...(rip.autoSummary ? [] : [' no auto-summary']),
  ];
}

function routeLine({ prefix, nextHop, distance }: StaticRoute): string {
  const via = nextHop.kind === 'address' ? nextHop.address : nextHop.interface;
  const suffix = distance === undefined ? '' : ` ${distance}`;
  return `ip route ${prefix.address} ${formatSubnetMask(prefix.prefixLength)} ${via}${suffix}`;
}

/** `lease` as IOS writes it: days, then hours and minutes only as far as they are needed. */
function leaseLine(lease: NonNullable<DhcpPool['lease']>): string {
  if (lease === 'infinite') return ' lease infinite';
  const parts = [Math.floor(lease / 1440), Math.floor((lease % 1440) / 60), lease % 60];
  while (parts.length > 1 && parts.at(-1) === 0) parts.pop();
  return ` lease ${parts.join(' ')}`;
}

/** The excluded ranges, then each pool as a block, every group closed by `!`. */
function dhcpLines({ excluded, pools }: DhcpServerConfig): string[] {
  const out = excluded.map(({ first, last }) =>
    first === last
      ? `ip dhcp excluded-address ${first}`
      : `ip dhcp excluded-address ${first} ${last}`,
  );
  if (out.length > 0) out.push('!');
  for (const [name, pool] of Object.entries(pools)) {
    out.push(`ip dhcp pool ${name}`);
    if (pool.network) {
      const { address, prefixLength } = pool.network;
      out.push(` network ${address} ${formatSubnetMask(prefixLength)}`);
    }
    if (pool.defaultRouters) out.push(` default-router ${pool.defaultRouters.join(' ')}`);
    if (pool.dnsServers) out.push(` dns-server ${pool.dnsServers.join(' ')}`);
    if (pool.lease !== undefined) out.push(leaseLine(pool.lease));
    out.push('!');
  }
  return out;
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
  const users = usernameLines(config);
  if (users.length > 0) out.push('!', ...users, '!');
  if (device.kind === 'router' && device.config.dhcp) out.push(...dhcpLines(device.config.dhcp));
  if (device.kind === 'switch' && device.config.ipRouting) out.push('ip routing');
  if (device.kind === 'router' && device.config.ipv6UnicastRouting) {
    out.push('ipv6 unicast-routing');
  }
  out.push(...sshLines(config));
  if (!config.domainLookup) out.push('no ip domain-lookup');
  if (config.domainName !== undefined) out.push(`ip domain-name ${config.domainName}`);
  out.push('!');
  if (device.kind === 'switch') {
    out.push(...errdisableLines(device.config));
    if (device.config.loadBalance) {
      out.push(`port-channel load-balance ${device.config.loadBalance}`, '!');
    }
    out.push(...spanningTreeLines(device.config), '!');
  }
  for (const entry of interfaceEntries(device)) out.push(...interfaceBlock(entry), '!');
  if (device.kind === 'router' && device.config.eigrp) {
    out.push(...eigrpLines(device.config.eigrp), '!');
  }
  if (device.kind === 'router' && device.config.ospf) {
    out.push(...ospfBlock(device.config.ospf), '!');
  }
  if (device.kind === 'router' && device.config.rip) out.push(...ripBlock(device.config.rip), '!');
  if (device.kind === 'router' && device.config.nat) out.push(...natLines(device.config.nat), '!');
  const staticRoutes = config.staticRoutes ?? [];
  if (staticRoutes.length > 0) out.push(...staticRoutes.map(routeLine), '!');
  const ipv6Routes = device.kind === 'router' ? (device.config.ipv6StaticRoutes ?? []) : [];
  if (ipv6Routes.length > 0) out.push(...ipv6Routes.map(ipv6RouteLine), '!');
  out.push(...accessListLines(device));
  if (device.kind === 'switch' && device.config.defaultGateway) {
    out.push(`ip default-gateway ${device.config.defaultGateway}`, '!');
  }
  const discovery = discoveryGlobalLines(config);
  if (discovery.length > 0) out.push(...discovery, '!');
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

type Status = readonly [status: string, protocol: string];

const ADMIN_DOWN: Status = ['administratively down', 'down'];
const UP: Status = ['up', 'up'];
const DOWN: Status = ['down', 'down'];

/** An SVI is up while its VLAN exists, and its protocol while an up port carries the VLAN. */
function sviStatus(device: IosDevice, vlan: VlanId, ports: PortStates): Status {
  if (device.kind !== 'switch' || !(vlan in device.config.vlans)) return DOWN;
  const carried = Object.entries(device.config.interfaces).some(
    ([id, port]) =>
      ports[id as Port['id']] === true && isSwitched(port) && carriesVlan(port.switchport, vlan),
  );
  return ['up', carried ? 'up' : 'down'];
}

/**
 * An interface's status and line protocol. With `ports` from the simulation, a port is up while
 * its link is; without them, from config alone, every interface not shut down is up.
 */
export function interfaceStatus(
  device: IosDevice,
  entry: InterfaceEntry,
  ports?: PortStates,
): Status {
  if (entry.config.shutdown) return ADMIN_DOWN;
  if (entry.kind === 'subinterface') {
    const parent = findInterface(device, entry.port.id);
    if (parent) return interfaceStatus(device, parent, ports);
  }
  if (!ports) return UP;
  if (entry.kind === 'port-channel') {
    return entry.members.some((member) => ports[member]) ? UP : DOWN;
  }
  if (entry.port) return ports[entry.port.id] ? UP : DOWN;
  if (typeOf(entry.id) === 'Vlan') return sviStatus(device, numberOf(entry.id) as VlanId, ports);
  return UP;
}

export function showIpInterfaceBrief(device: IosDevice, ports?: PortStates): string[] {
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
      const ipv4 = isLayer2(entry) ? undefined : entry.config.ipv4;
      return row([
        entry.id,
        ipv4?.address ?? 'unassigned',
        'YES',
        ipv4 ? 'manual' : 'unset',
        ...interfaceStatus(device, entry, ports),
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
  'Port-channel': { name: 'EtherChannel', bandwidth: 100000, delay: 100, encapsulation: 'ARPA' },
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
export function ciscoMac(mac: string): string {
  return mac.replace(/:/g, '').match(/.{4}/g)!.join('.');
}

function interfaceDetail(device: IosDevice, entry: InterfaceEntry, ports?: PortStates): string[] {
  const hardware = HARDWARE[typeOf(entry.id)];
  const [state, protocol] = interfaceStatus(device, entry, ports);
  const macs = device.ports.flatMap((port) => (port.kind === 'serial' ? [] : [port.mac]));
  // A VLAN interface answers with the switch's first Ethernet MAC.
  const mac = entry.port ? (entry.port.kind === 'serial' ? undefined : entry.port.mac) : macs[0];
  const address =
    mac && hardware.encapsulation === 'ARPA'
      ? `, address is ${ciscoMac(mac)} (bia ${ciscoMac(mac)})`
      : '';
  const ipv4 = isLayer2(entry) ? undefined : entry.config.ipv4;
  const speed =
    entry.kind === 'subinterface' || entry.kind === 'port-channel' ? undefined : entry.config.speed;
  const configured = isLayer2(entry) ? undefined : entry.config;
  // An Ethernet port's delay follows its speed: 10 µs at 1 Gbit/s, 100 at 100 Mbit/s.
  const bandwidth = configured?.bandwidth ?? (speed ? speed * 1000 : hardware.bandwidth);
  const delay =
    configured?.delay !== undefined
      ? configured.delay * 10
      : speed
        ? 10_000 / speed
        : hardware.delay;
  const encapsulation =
    entry.kind === 'subinterface' && entry.config.encapsulation
      ? `802.1Q Virtual LAN, Vlan ID  ${entry.config.encapsulation.vlan}`
      : hardware.encapsulation;
  return [
    `${entry.id} is ${state}, line protocol is ${protocol}`,
    `  Hardware is ${hardware.name}${address}`,
    ...(entry.config.description === undefined
      ? []
      : [`  Description: ${entry.config.description}`]),
    ...(ipv4 ? [`  Internet address is ${ipv4.address}/${ipv4.prefixLength}`] : []),
    `  MTU 1500 bytes, BW ${bandwidth} Kbit, DLY ${delay} usec,`,
    `  Encapsulation ${encapsulation}, loopback not set`,
  ];
}

export function showInterfaces(
  device: IosDevice,
  only?: InterfaceId,
  ports?: PortStates,
): string[] | undefined {
  const entries = interfaceEntries(device).filter(
    (entry) => only === undefined || entry.id === only,
  );
  if (only !== undefined && entries.length === 0) return undefined;
  return entries.flatMap((entry) => interfaceDetail(device, entry, ports));
}
