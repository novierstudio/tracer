// Maps a decrypted Packet Tracer network onto a Tracer Topology, and reports what it imported,
// approximated or skipped on the way.

import {
  DEFAULT_CENTRAL_OFFICE,
  DEFAULT_HOME_GATEWAY,
  DEFAULT_HOME_ROUTER,
  DEFAULT_RADIO,
  HOME_GATEWAY_MODEL,
  type IotConfig,
  consolePortOf,
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
  type ConsolePortKind,
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
  RouterConfig,
  SwitchConfig,
  type SwitchInterface,
  type Topology,
} from '@/model';
import { applyLines, type IosDevice } from '@/cli';
import { findDeviceModel, findDeviceModelByName, type DeviceModelId } from '@/devices/catalog';
import { inferModules, storedModules } from '@/devices/modules';
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

/**
 * Replays a router's or switch's running-config onto the device the mapper built from its PORT
 * elements, as if the lines were typed in config mode, and returns the resulting config. Lines it
 * cannot apply belong in `unknownLines`. The mapper sets `hostname` back to the canvas label
 * afterwards, so that labels stay unique.
 */
export type ReplayConfig = <D extends IosDevice>(
  device: D,
  lines: readonly string[],
) => D['config'];

/** The default: runs each line through Tracer's IOS command set. */
export const replayWithIos: ReplayConfig = (device, lines) => applyLines(device, lines).config;

/** Keeps every line verbatim in `unknownLines` without applying any. */
export const keepLinesAsUnknown: ReplayConfig = (device, lines) => ({
  ...device.config,
  unknownLines: [...device.config.unknownLines, ...lines],
});

export type MapOptions = {
  /** The topology's name, such as the file name. */
  readonly name?: string;
  readonly now?: Date;
  readonly ids?: IdSource;
  readonly replayConfig?: ReplayConfig;
};

/** The steps of `importPkt`, in order. */
export type PktStage = 'decrypting' | 'decompressing' | 'mapping';

export type ImportOptions = MapOptions & {
  /** Called as each step starts. */
  readonly onStage?: (stage: PktStage) => void;
};

export type PktImport = { readonly topology: Topology; readonly report: ImportReport };

export type PktImportError =
  PtXmlError | { readonly kind: 'decrypt-failed'; readonly error: DecryptError };

export function importPkt(
  bytes: Uint8Array,
  { onStage, ...options }: ImportOptions = {},
): Result<PktImport, PktImportError> {
  onStage?.('decrypting');
  const decrypted = decryptPkt(bytes, () => onStage?.('decompressing'));
  if (!decrypted.ok) return err({ kind: 'decrypt-failed', error: decrypted.error });
  onStage?.('mapping');
  return mapPktXml(decrypted.xml, options);
}

export function mapPktXml(xml: string, options: MapOptions = {}): Result<PktImport, PtXmlError> {
  const network = readPtNetwork(xml);
  return network.ok ? ok(mapNetwork(network.value, options)) : network;
}

/** `model` is the catalog model for a device whose Packet Tracer model the catalog lacks. */
type KindRule = {
  readonly kind: DeviceKind;
  readonly approximated: boolean;
  readonly model?: DeviceModelId;
};

// Each device takes the catalog model of its Packet Tracer model name, such as 2911 or 3650-24PS.
// A MultiLayerSwitch the catalog lacks is a 3560-24PS, so its `ip routing`, routed ports and static
// routes replay. A hub, repeater, bridge, access point and home router take its catalog model's
// ports in order; the file's wireless settings are not read, so the radios ship with factory
// settings. Types missing here, such as Printer, are skipped.
const DEVICE_KINDS = new Map<string, KindRule>([
  ['Router', { kind: 'router', approximated: false }],
  ['Switch', { kind: 'switch', approximated: false }],
  ['MultiLayerSwitch', { kind: 'switch', approximated: false, model: 'switch-l3-24' }],
  ['Pc', { kind: 'pc', approximated: false }],
  ['Laptop', { kind: 'pc', approximated: false }],
  ['Server', { kind: 'server', approximated: false }],
  ['Hub', { kind: 'hub', approximated: false, model: 'hub' }],
  ['Repeater', { kind: 'hub', approximated: false, model: 'repeater-pt' }],
  ['Bridge', { kind: 'hub', approximated: true, model: 'bridge-pt' }],
  ['AccessPoint', { kind: 'accessPoint', approximated: true, model: 'access-point' }],
  ['WirelessRouter', { kind: 'wirelessRouter', approximated: true, model: 'wireless-router' }],
]);

/**
 * Packet Tracer models Tracer has a model of its own for, whatever type the file gives them. They
 * take that model's ports in order, and its factory settings: the file's wireless, WLAN, cell and
 * IoT settings are not read.
 */
const PT_MODELS = new Map<string, DeviceModelId>([
  ['AccessPoint-PT-A', 'access-point-a'],
  ['AccessPoint-PT-N', 'access-point-n'],
  ['AccessPoint-PT-AC', 'access-point-ac'],
  ['LAP-PT', 'lap-pt'],
  ['3702i', 'lap-3702i'],
  ['WLC-PT', 'wlc-pt'],
  ['WLC-2504', 'wlc-2504'],
  ['DLC100', HOME_GATEWAY_MODEL],
  ['HomeGateway', HOME_GATEWAY_MODEL],
  ['Cell-Tower', 'cell-tower'],
  ['Central-Office-Server', 'central-office'],
  ['MCU-PT', 'iot-mcu'],
  ['SBC-PT', 'iot-sbc'],
]);

/** An IoT thing's model, by words in its Packet Tracer model name, first match wins. */
const PT_THINGS: readonly [RegExp, DeviceModelId][] = [
  [/motion/i, 'iot-motion'],
  [/smoke/i, 'iot-smoke'],
  [/siren/i, 'iot-siren'],
  [/thermostat/i, 'iot-thermostat'],
  [/webcam|camera/i, 'iot-webcam'],
  [/window/i, 'iot-window'],
  [/door/i, 'iot-door'],
  [/fan/i, 'iot-fan'],
  [/lamp|light/i, 'iot-lamp'],
  [/^mcu/i, 'iot-mcu'],
  [/^sbc/i, 'iot-sbc'],
  [/thing/i, 'iot-thing'],
];

/** The rule for a device: by its model where Tracer has one, else by its type. */
function kindRule(pt: PtDevice): KindRule | undefined {
  const named =
    PT_MODELS.get(pt.model) ??
    (DEVICE_KINDS.has(pt.type)
      ? undefined
      : PT_THINGS.find(([pattern]) => pattern.test(pt.model || pt.type))?.[1]);
  const model = named && findDeviceModel(named);
  return model ? { kind: model.kind, approximated: true, model: named } : DEVICE_KINDS.get(pt.type);
}

const KIND_LABEL: Record<DeviceKind, string> = {
  router: 'Router',
  switch: 'Switch',
  pc: 'PC',
  server: 'Server',
  hub: 'Hub',
  accessPoint: 'Access point',
  wirelessRouter: 'Wireless router',
  lightweightAp: 'Lightweight AP',
  wlc: 'Wireless LAN controller',
  cellTower: 'Cell tower',
  centralOffice: 'Central office server',
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

/** A port's type, by its PORT/TYPE. Any wireless card is a host's radio, `Wireless0`. */
const ptPortType = (type: string) =>
  PT_PORT_TYPES.get(type) ??
  (/wireless/i.test(type) ? { prefix: 'Wireless', fiber: false } : undefined);

const PORT_KINDS = new Map<string, PortKind>([
  ['FastEthernet', 'fastEthernet'],
  ['GigabitEthernet', 'gigabitEthernet'],
  ['Serial', 'serial'],
  ['Wireless', 'wireless'],
]);

const CABLES = new Map<string, Cable>([
  ['eStraightThrough', 'straight'],
  ['eCrossOver', 'crossover'],
  ['eFiber', 'fiber'],
  ['eSerial', 'serial'],
  // A console cable is a rollover cable.
  ['eRollOver', 'console'],
  ['eConsole', 'console'],
]);

/** How Packet Tracer names the management ports a console cable plugs into. */
const CONSOLE_PORT_NAMES = /^(?:console|rs ?232)$/i;

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
    replay: options.replayConfig ?? replayWithIos,
    entries: [],
    hostname: hostnameAllocator(),
  };
  const topology = emptyTopology({
    name: options.name ?? 'Packet Tracer import',
    now: options.now ?? new Date(),
  });

  const kept = network.devices.filter((pt) => kindRule(pt));
  const origin = {
    x: kept.length > 0 ? Math.min(...kept.map((pt) => pt.x)) : 0,
    y: kept.length > 0 ? Math.min(...kept.map((pt) => pt.y)) : 0,
  };

  const placed = new Map<string, Placed>();
  for (const pt of network.devices) {
    const rule = kindRule(pt);
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

  const named = findDeviceModelByName(pt.model);
  const catalog =
    (named?.kind === kind ? named : undefined) ??
    (rule.model ? findDeviceModel(rule.model) : undefined);
  // A hub's, an access point's and a home router's ports are its catalog model's, in order.
  const model = kind === 'router' || kind === 'switch' ? undefined : catalog;
  const listed = model
    ? model.ports.map((port) => port.id)
    : kind === 'router' || kind === 'switch'
      ? configPortNames(pt)
      : hostPortNames(pt);
  if (!listed) entries.push({ kind: 'port-names-guessed', device: id });
  const names = listed ?? slotPortNames(pt);
  const kindOf = (name: string, index: number) =>
    model ? model.ports[index]?.kind : PORT_KINDS.get(interfaceType(name));

  const ports: { readonly port: Port; readonly pt: PtPort }[] = [];
  pt.ports.forEach((ptPort, index) => {
    const name = names[index] ?? '';
    const portKind = kindOf(name, index);
    const portId = PortId.safeParse(name);
    if (!portKind || !portId.success) {
      entries.push({ kind: 'port-skipped', device: id, port: name, ptType: ptPort.type });
      return;
    }
    const mac = () => macAddress(ptPort, id, portId.data, ctx);
    const port: Port =
      portKind === 'serial'
        ? { kind: portKind, id: portId.data }
        : portKind === 'wireless'
          ? {
              kind: portKind,
              id: portId.data,
              mac: mac(),
              ...(model?.ports[index]?.cellular && { cellular: true }),
            }
          : {
              kind: portKind,
              id: portId.data,
              mac: mac(),
              ...(ptPortType(ptPort.type)?.fiber && { fiber: true }),
              ...(model?.ports[index]?.coaxial && { coaxial: true }),
            };
    ports.push({ port, pt: ptPort });
  });

  const devicePorts = ports.map(({ port }) => port);
  const fields = {
    id,
    model: catalog?.id ?? (pt.model || pt.type),
    position,
    powered: pt.power,
    ports: devicePorts,
    // The file lists ports, not modules: each slot gets the module whose ports it has.
    ...(catalog?.slots && { modules: storedModules(inferModules(catalog, devicePorts)) }),
  };
  // "!" lines only separate blocks in a running-config.
  const lines = pt.runningConfig.filter((line) => !/^\s*!?\s*$/.test(line));
  const replay = <D extends IosDevice>(device: D): D => {
    const replayed = ctx.replay(device, lines);
    if (replayed.unknownLines.length > 0) {
      entries.push({ kind: 'config-kept', device: id, lines: replayed.unknownLines });
    }
    return { ...device, config: { ...replayed, hostname } };
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
      // Parsing fills the IOS settings the file has no PORT data for with their defaults.
      const config = RouterConfig.parse({ hostname, interfaces, unknownLines: [] });
      device = replay({ ...fields, kind, config });
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
      const config = SwitchConfig.parse({
        hostname,
        interfaces,
        vlans: switchVlans(pt),
        unknownLines: [],
      });
      device = replay({ ...fields, kind, config });
      break;
    }
    case 'pc':
    case 'server': {
      const iot = (model?.config as { iot?: IotConfig } | undefined)?.iot;
      const config = hostConfig(pt, hostname, id, entries);
      device = { ...fields, kind, config: iot ? { ...config, iot } : config };
      break;
    }
    case 'hub':
      device = { ...fields, kind, config: { hostname } };
      break;
    case 'accessPoint': {
      const radio = (model?.config as { radio?: typeof DEFAULT_RADIO } | undefined)?.radio;
      device = { ...fields, kind, config: { hostname, radio: radio ?? DEFAULT_RADIO } };
      break;
    }
    case 'wirelessRouter': {
      const factory =
        rule.model === HOME_GATEWAY_MODEL ? DEFAULT_HOME_GATEWAY : DEFAULT_HOME_ROUTER;
      device = { ...fields, kind, config: { ...factory, hostname } };
      break;
    }
    case 'lightweightAp':
    case 'cellTower':
      device = { ...fields, kind, config: { hostname } };
      break;
    case 'wlc':
      device = { ...fields, kind, config: { hostname, management: { mode: 'static' }, wlans: [] } };
      break;
    case 'centralOffice':
      device = { ...fields, kind, config: { ...DEFAULT_CENTRAL_OFFICE, hostname } };
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
      const prefix = ptPortType(port.type)?.prefix;
      return prefix === undefined || interfaceType(names[index] ?? '') === prefix;
    });
  return fits ? names : undefined;
}

/** A host numbers each type of port from 0: FastEthernet0, GigabitEthernet0. */
function hostPortNames(pt: PtDevice): readonly (string | undefined)[] {
  const counts = new Map<string, number>();
  return pt.ports.map((port) => {
    const prefix = ptPortType(port.type)?.prefix;
    if (!prefix) return undefined;
    const count = counts.get(prefix) ?? 0;
    counts.set(prefix, count + 1);
    return `${prefix}${count}`;
  });
}

/** Port 1 of the module in slot 0 is GigabitEthernet0/1. Right for routers, but switches count from 1. */
function slotPortNames(pt: PtDevice): readonly (string | undefined)[] {
  return pt.ports.map((port) => {
    const prefix = ptPortType(port.type)?.prefix;
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
): Result<
  { readonly endpoint: Endpoint; readonly kind: PortKind | ConsolePortKind },
  LinkDropReason
> {
  const target = placed.get(end.device);
  if (!target) return err({ kind: 'device-not-found' });
  if (!target.mapped) return err({ kind: 'device-skipped' });
  const { device, ports } = target.mapped;
  const console = CONSOLE_PORT_NAMES.test(end.port) && consolePortOf(device.kind);
  if (console) return ok({ endpoint: { device: device.id, port: console.id }, kind: console.kind });
  // Packet Tracer 5.x names a host's only port without a number: FastEthernet for FastEthernet0.
  // A hub's `Port 0` and a home router's `Ethernet 1` are Tracer's Port0 and Ethernet1.
  const port =
    ports.get(end.port) ??
    ports.get(end.port.replace(/\s+/g, '')) ??
    (/\d$/.test(end.port) ? undefined : ports.get(`${end.port}0`));
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
