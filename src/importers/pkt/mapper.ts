// Maps a decrypted Packet Tracer network onto a Tracer Topology, and reports what it imported,
// approximated or skipped on the way.

import {
  createIdSource,
  emptyTopology,
  err,
  findLinkProblem,
  Hostname,
  Ipv4Address,
  MacAddress,
  ok,
  PortId,
  SubnetMask,
  VlanId,
  type Cable,
  type Device,
  type DeviceId,
  type DeviceKind,
  type Endpoint,
  type HostConfig,
  type IdSource,
  type Ipv4Cidr,
  type Link,
  type Point,
  type Port,
  type PortKind,
  type Result,
  type RoutedInterface,
  type RouterConfig,
  type SwitchConfig,
  type SwitchInterface,
  type Topology,
} from '@/model';
import { decryptPkt, type DecryptError } from './codec';
import {
  readPtNetwork,
  type PtDevice,
  type PtEnd,
  type PtNetwork,
  type PtPort,
  type PtXmlError,
} from './network';
import type { ImportReport, LinkDropReason, PtLinkEnd, ReportEntry } from './report';

export type IosConfig = RouterConfig | SwitchConfig;

/**
 * Replays a router's or switch's running-config onto the config the mapper built from its PORT
 * elements, as if the lines were typed in config mode. Lines it cannot apply belong in
 * `unknownLines`. The mapper sets `hostname` back to the canvas label afterwards, so that labels
 * stay unique.
 */
export type ReplayConfig = <C extends IosConfig>(config: C, lines: readonly string[]) => C;

/** Keeps every line verbatim in `unknownLines`: the default until the CLI can apply config. */
export const keepLinesAsUnknown: ReplayConfig = (config, lines) => ({
  ...config,
  unknownLines: [...config.unknownLines, ...lines],
});

export type MapOptions = {
  /** The topology's name, such as the file name. */
  readonly name?: string;
  readonly now?: Date;
  readonly ids?: IdSource;
  readonly replayConfig?: ReplayConfig;
};

export type PktImport = { readonly topology: Topology; readonly report: ImportReport };

export type PktImportError =
  PtXmlError | { readonly kind: 'decrypt-failed'; readonly error: DecryptError };

export function importPkt(
  bytes: Uint8Array,
  options?: MapOptions,
): Result<PktImport, PktImportError> {
  const decrypted = decryptPkt(bytes);
  if (!decrypted.ok) return err({ kind: 'decrypt-failed', error: decrypted.error });
  return mapPktXml(decrypted.xml, options);
}

export function mapPktXml(xml: string, options: MapOptions = {}): Result<PktImport, PtXmlError> {
  const network = readPtNetwork(xml);
  return network.ok ? ok(mapNetwork(network.value, options)) : network;
}

type KindRule = { readonly kind: DeviceKind; readonly approximated: boolean };

// A MultiLayerSwitch imports as a switch so that its links survive. Its routing waits for layer 3
// switches (NOV-229). Types missing here, such as Printer or AccessPoint, are skipped.
const DEVICE_KINDS = new Map<string, KindRule>([
  ['Router', { kind: 'router', approximated: false }],
  ['Switch', { kind: 'switch', approximated: false }],
  ['MultiLayerSwitch', { kind: 'switch', approximated: true }],
  ['Pc', { kind: 'pc', approximated: false }],
  ['Laptop', { kind: 'pc', approximated: false }],
  ['Server', { kind: 'server', approximated: false }],
]);

const KIND_LABEL: Record<DeviceKind, string> = {
  router: 'Router',
  switch: 'Switch',
  pc: 'PC',
  server: 'Server',
};

// The interface name prefix of each PORT/TYPE.
const PT_PORT_TYPES = new Map<string, { readonly prefix: string; readonly fiber: boolean }>([
  ['eCopperEthernet', { prefix: 'Ethernet', fiber: false }],
  ['eCopperFastEthernet', { prefix: 'FastEthernet', fiber: false }],
  ['eFiberFastEthernet', { prefix: 'FastEthernet', fiber: true }],
  ['eCopperGigabitEthernet', { prefix: 'GigabitEthernet', fiber: false }],
  ['eFiberGigabitEthernet', { prefix: 'GigabitEthernet', fiber: true }],
  ['eSerial', { prefix: 'Serial', fiber: false }],
  ['eSmartSerial', { prefix: 'Serial', fiber: false }],
]);

const PORT_KINDS = new Map<string, PortKind>([
  ['FastEthernet', 'fastEthernet'],
  ['GigabitEthernet', 'gigabitEthernet'],
  ['Serial', 'serial'],
]);

const CABLES = new Map<string, Cable>([
  ['eStraightThrough', 'straight'],
  ['eCrossOver', 'crossover'],
  ['eSerial', 'serial'],
]);

const LOGICAL_INTERFACE = /^(?:Vlan|Loopback|Tunnel|Port-channel|Virtual-|Dialer|BVI|NVI|Null)/i;

const DEFAULT_VLAN = VlanId.parse(1);

const HOSTNAME_MAX = 63;

type Context = {
  readonly ids: IdSource;
  readonly replay: ReplayConfig;
  readonly entries: ReportEntry[];
  readonly hostname: (name: string, kind: DeviceKind) => Hostname;
};

type Mapped = { readonly device: Device; readonly ports: ReadonlyMap<string, Port> };

type Placed = { readonly pt: PtDevice; readonly mapped: Mapped | undefined };

function mapNetwork(network: PtNetwork, options: MapOptions): PktImport {
  const ctx: Context = {
    ids: options.ids ?? createIdSource(),
    replay: options.replayConfig ?? keepLinesAsUnknown,
    entries: [],
    hostname: hostnameAllocator(),
  };
  const topology = emptyTopology({
    name: options.name ?? 'Packet Tracer import',
    now: options.now ?? new Date(),
  });

  const kept = network.devices.filter((pt) => DEVICE_KINDS.has(pt.type));
  const origin = {
    x: kept.length > 0 ? Math.min(...kept.map((pt) => pt.x)) : 0,
    y: kept.length > 0 ? Math.min(...kept.map((pt) => pt.y)) : 0,
  };

  const placed = new Map<string, Placed>();
  for (const pt of network.devices) {
    const rule = DEVICE_KINDS.get(pt.type);
    const position = { x: pt.x - origin.x, y: pt.y - origin.y };
    const mapped = rule && mapDevice(pt, rule, position, ctx);
    if (mapped) {
      topology.devices[mapped.device.id] = mapped.device;
    } else {
      ctx.entries.push({ kind: 'device-skipped', name: pt.name, ptType: pt.type, model: pt.model });
    }
    for (const ref of [String(pt.index), pt.saveRefId]) if (ref) placed.set(ref, { pt, mapped });
  }

  for (const link of network.links) {
    const from = resolveEnd(link.from, placed);
    const to = resolveEnd(link.to, placed);
    if (!from.ok) {
      dropLink(link.from, link.to, from.error, placed, ctx);
      continue;
    }
    if (!to.ok) {
      dropLink(link.from, link.to, to.error, placed, ctx);
      continue;
    }

    const known = CABLES.get(link.cable);
    const cable =
      known ?? (from.value.kind === 'serial' && to.value.kind === 'serial' ? 'serial' : 'straight');
    const id = ctx.ids.linkId();
    const [a, b] = [from.value.endpoint, to.value.endpoint];
    // Packet Tracer records the DCE end of every serial cable. Without it, end a is DCE.
    const dceIsB =
      link.dce && (link.dce.device !== link.from.device || link.dce.port !== link.from.port);
    const candidate: Link =
      cable === 'serial' ? { id, cable, a, b, dce: dceIsB ? 'b' : 'a' } : { id, cable, a, b };

    const problem = findLinkProblem(topology, candidate);
    if (problem) {
      dropLink(link.from, link.to, { kind: 'invalid', error: problem }, placed, ctx);
      continue;
    }
    topology.links[id] = candidate;
    if (!known) {
      ctx.entries.push({ kind: 'cable-approximated', link: id, ptCable: link.cable, cable });
    }
  }

  const devices = Object.keys(topology.devices).length;
  const links = Object.keys(topology.links).length;
  return {
    topology,
    report: {
      ptVersion: network.version,
      activity: network.activity,
      devices: { imported: devices, skipped: network.devices.length - devices },
      links: { imported: links, dropped: network.links.length - links },
      entries: ctx.entries,
    },
  };
}

function mapDevice(pt: PtDevice, rule: KindRule, position: Point, ctx: Context): Mapped {
  const { ids, entries } = ctx;
  const { kind } = rule;
  const id = ids.deviceId();
  if (rule.approximated) {
    entries.push({ kind: 'device-approximated', device: id, ptType: pt.type, as: kind });
  }

  const hostname = ctx.hostname(pt.name, kind);
  if (hostname !== pt.name) {
    entries.push({ kind: 'hostname-changed', device: id, name: pt.name, hostname });
  }

  const named = kind === 'router' || kind === 'switch' ? configPortNames(pt) : hostPortNames(pt);
  if (!named) entries.push({ kind: 'port-names-guessed', device: id });
  const names = named ?? slotPortNames(pt);

  const ports: { readonly port: Port; readonly pt: PtPort }[] = [];
  pt.ports.forEach((ptPort, index) => {
    const name = names[index] ?? '';
    const portKind = PORT_KINDS.get(interfaceType(name));
    const portId = PortId.safeParse(name);
    if (!portKind || !portId.success) {
      entries.push({ kind: 'port-skipped', device: id, port: name, ptType: ptPort.type });
      return;
    }
    if (PT_PORT_TYPES.get(ptPort.type)?.fiber) {
      entries.push({
        kind: 'port-approximated',
        device: id,
        port: portId.data,
        ptType: ptPort.type,
      });
    }
    const port: Port =
      portKind === 'serial'
        ? { kind: portKind, id: portId.data }
        : { kind: portKind, id: portId.data, mac: macAddress(ptPort, id, portId.data, ctx) };
    ports.push({ port, pt: ptPort });
  });

  const fields = {
    id,
    model: pt.model || pt.type,
    position,
    powered: pt.power,
    ports: ports.map(({ port }) => port),
  };
  // "!" lines only separate blocks in a running-config.
  const lines = pt.runningConfig.filter((line) => !/^\s*!?\s*$/.test(line));
  const replay = <C extends IosConfig>(config: C): C => {
    const replayed = ctx.replay(config, lines);
    if (replayed.unknownLines.length > 0) {
      entries.push({ kind: 'config-kept', device: id, lines: replayed.unknownLines });
    }
    return { ...replayed, hostname };
  };

  let device: Device;
  switch (kind) {
    case 'router': {
      const interfaces = Object.fromEntries(
        ports.map(({ port, pt: p }): [PortId, RoutedInterface] => [
          port.id,
          {
            shutdown: !p.power,
            ipv4: parseCidr(p, id, entries),
            description: p.description || undefined,
          },
        ]),
      );
      device = { ...fields, kind, config: replay({ hostname, interfaces, unknownLines: [] }) };
      break;
    }
    case 'switch': {
      const interfaces = Object.fromEntries(
        ports.map(({ port, pt: p }): [PortId, SwitchInterface] => [
          port.id,
          {
            shutdown: !p.power,
            switchport: { mode: 'access', vlan: DEFAULT_VLAN },
            description: p.description || undefined,
          },
        ]),
      );
      const config = { hostname, interfaces, vlans: switchVlans(pt), unknownLines: [] };
      device = { ...fields, kind, config: replay(config) };
      break;
    }
    case 'pc':
    case 'server':
      device = { ...fields, kind, config: hostConfig(pt, hostname, id, entries) };
      break;
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
  return { device, ports: new Map(ports.map(({ port }) => [port.id, port])) };
}

/** FastEthernet for FastEthernet0/1. */
const interfaceType = (name: string) => /^\D*/.exec(name)?.[0] ?? '';

/**
 * A router or switch names its ports in its running-config, which lists the physical interfaces
 * in port order. Undefined when the two lists do not line up.
 */
function configPortNames(pt: PtDevice): readonly string[] | undefined {
  const names = pt.runningConfig.flatMap((line) => {
    const name = /^interface\s+(\S+)/.exec(line)?.[1];
    return name && !name.includes('.') && !LOGICAL_INTERFACE.test(name) ? [name] : [];
  });
  const fits =
    names.length === pt.ports.length &&
    pt.ports.every((port, index) => {
      const prefix = PT_PORT_TYPES.get(port.type)?.prefix;
      return prefix === undefined || interfaceType(names[index] ?? '') === prefix;
    });
  return fits ? names : undefined;
}

/** A host numbers each type of port from 0: FastEthernet0, GigabitEthernet0. */
function hostPortNames(pt: PtDevice): readonly (string | undefined)[] {
  const counts = new Map<string, number>();
  return pt.ports.map((port) => {
    const prefix = PT_PORT_TYPES.get(port.type)?.prefix;
    if (!prefix) return undefined;
    const count = counts.get(prefix) ?? 0;
    counts.set(prefix, count + 1);
    return `${prefix}${count}`;
  });
}

/** Port 1 of the module in slot 0 is GigabitEthernet0/1. Right for routers, but switches count from 1. */
function slotPortNames(pt: PtDevice): readonly (string | undefined)[] {
  return pt.ports.map((port) => {
    const prefix = PT_PORT_TYPES.get(port.type)?.prefix;
    return prefix && `${prefix}${port.address.join('/')}`;
  });
}

function macAddress(port: PtPort, device: DeviceId, id: PortId, ctx: Context): MacAddress {
  const parsed = MacAddress.safeParse(port.mac);
  if (parsed.success) return parsed.data;
  ctx.entries.push({ kind: 'mac-generated', device, port: id });
  return ctx.ids.macAddress();
}

function parseCidr(port: PtPort, device: DeviceId, entries: ReportEntry[]): Ipv4Cidr | undefined {
  if (!port.ip && !port.subnet) return undefined;
  const address = Ipv4Address.safeParse(port.ip);
  const prefixLength = SubnetMask.safeParse(port.subnet);
  if (address.success && prefixLength.success) {
    return { address: address.data, prefixLength: prefixLength.data };
  }
  entries.push({
    kind: 'value-ignored',
    device,
    field: 'ipv4',
    value: `${port.ip} ${port.subnet}`.trim(),
  });
  return undefined;
}

function parseAddress(
  text: string,
  field: 'gateway' | 'dns',
  device: DeviceId,
  entries: ReportEntry[],
): Ipv4Address | undefined {
  if (!text) return undefined;
  const parsed = Ipv4Address.safeParse(text);
  if (parsed.success) return parsed.data;
  entries.push({ kind: 'value-ignored', device, field, value: text });
  return undefined;
}

function hostConfig(
  pt: PtDevice,
  hostname: Hostname,
  device: DeviceId,
  entries: ReportEntry[],
): HostConfig {
  // A Tracer host has one IP configuration. It comes from the first port that has one.
  const port = pt.ports.find((candidate) => candidate.dhcp || candidate.ip !== '');
  if (port?.dhcp) return { hostname, ipv4: { mode: 'dhcp' } };
  return {
    hostname,
    ipv4: {
      mode: 'static',
      address: port && parseCidr(port, device, entries),
      gateway: parseAddress(port?.gateway || pt.gateway, 'gateway', device, entries),
      dns: parseAddress(port?.dns || pt.dns, 'dns', device, entries),
    },
  };
}

function switchVlans(pt: PtDevice): SwitchConfig['vlans'] {
  const vlans: SwitchConfig['vlans'] = { [DEFAULT_VLAN]: { name: 'default' } };
  for (const { number, name } of pt.vlans) {
    const id = VlanId.safeParse(number);
    // IOS creates VLANs 1002 to 1005 itself. A switch made in Tracer has only VLAN 1.
    if (!id.success || (number >= 1002 && number <= 1005)) continue;
    vlans[id.data] = { name: name.slice(0, 32) || `VLAN${String(number).padStart(4, '0')}` };
  }
  return vlans;
}

const trimEnd = (text: string) => text.replace(/[^A-Za-z0-9]+$/, '');

/** "Web Server" becomes Web-Server. A label with no usable letters becomes the kind's label. */
function hostnameBase(name: string, kind: DeviceKind): string {
  const ascii = name.normalize('NFKD').replace(/[̀-ͯ]/g, '');
  const cleaned = ascii.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^[-_]+|[-_]+$/g, '');
  const label = KIND_LABEL[kind];
  const lettered =
    cleaned === '' ? label : /^[A-Za-z]/.test(cleaned) ? cleaned : `${label}-${cleaned}`;
  return trimEnd(lettered.slice(0, HOSTNAME_MAX));
}

/** Hands out valid hostnames in device order. A repeat gets -2, -3 and so on, ignoring case. */
function hostnameAllocator(): Context['hostname'] {
  const taken = new Set<string>();
  return (name, kind) => {
    const base = hostnameBase(name, kind);
    let hostname = base;
    for (let n = 2; taken.has(hostname.toLowerCase()); n += 1) {
      const suffix = `-${n}`;
      hostname = trimEnd(base.slice(0, HOSTNAME_MAX - suffix.length)) + suffix;
    }
    taken.add(hostname.toLowerCase());
    return Hostname.parse(hostname);
  };
}

function resolveEnd(
  end: PtEnd,
  placed: ReadonlyMap<string, Placed>,
): Result<{ readonly endpoint: Endpoint; readonly kind: PortKind }, LinkDropReason> {
  const target = placed.get(end.device);
  if (!target) return err({ kind: 'device-not-found' });
  if (!target.mapped) return err({ kind: 'device-skipped' });
  const { device, ports } = target.mapped;
  // Packet Tracer 5.x names a host's only port without a number: FastEthernet for FastEthernet0.
  const port =
    ports.get(end.port) ?? (/\d$/.test(end.port) ? undefined : ports.get(`${end.port}0`));
  if (!port) return err({ kind: 'port-not-imported' });
  return ok({ endpoint: { device: device.id, port: port.id }, kind: port.kind });
}

function dropLink(
  from: PtEnd,
  to: PtEnd,
  reason: LinkDropReason,
  placed: ReadonlyMap<string, Placed>,
  ctx: Context,
): void {
  const describe = (end: PtEnd): PtLinkEnd => ({
    device: placed.get(end.device)?.pt.name ?? end.device,
    port: end.port,
  });
  ctx.entries.push({ kind: 'link-dropped', from: describe(from), to: describe(to), reason });
}
