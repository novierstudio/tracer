// Reads the parts of decrypted Packet Tracer XML that the mapper uses into plain records.
// Everything stays a string here; the mapper parses values into model types.
//
//   PACKETTRACER5 (or PACKETTRACER5_ACTIVITY > PACKETTRACER5 x 3 in a .pka)
//   ├── VERSION
//   └── NETWORK
//       ├── DEVICES/DEVICE
//       │   ├── ENGINE: TYPE@model, NAME, POWER, SAVE_REF_ID (7.2+), GATEWAY, DNS_CLIENT/SERVER_IP,
//       │   │           MODULE/SLOT/MODULE/.../PORT, RUNNINGCONFIG/LINE, VLANS/VLAN@number@name
//       │   └── WORKSPACE/LOGICAL: X, Y
//       └── LINKS/LINK: TYPE, CABLE: TYPE, FROM, PORT, TO, PORT, DCEDEV, DCEPORT

import { XMLParser } from 'fast-xml-parser';
import { err, ok, type Result } from '@/model';

export type PtPort = {
  /** For example eCopperFastEthernet or eSmartSerial. */
  readonly type: string;
  /** Slot indexes from the chassis down, then the port's index in its module. */
  readonly address: readonly number[];
  readonly power: boolean;
  readonly mac: string;
  readonly ip: string;
  readonly subnet: string;
  /** PORT_GATEWAY, PORT_DNS and PORT_DHCP_ENABLE are missing before 6.x. */
  readonly gateway: string;
  readonly dns: string;
  readonly dhcp: boolean;
  readonly description: string;
};

export type PtDevice = {
  /** Position in DEVICES. Links refer to devices by it up to 7.1. */
  readonly index: number;
  /** `save-ref-id:<n>`. Links refer to devices by it from 7.2 on. Empty before 7.2. */
  readonly saveRefId: string;
  /** For example Router, Switch, Pc or Printer. */
  readonly type: string;
  /** The hardware model, such as 2811 or PC-PT. */
  readonly model: string;
  /** The label on the canvas. */
  readonly name: string;
  readonly power: boolean;
  readonly x: number;
  readonly y: number;
  /** A module's own ports come before the ports of the modules in its slots. */
  readonly ports: readonly PtPort[];
  readonly runningConfig: readonly string[];
  /** Host settings that older versions keep on the device instead of the port. */
  readonly gateway: string;
  readonly dns: string;
  readonly vlans: readonly { readonly number: number; readonly name: string }[];
};

export type PtEnd = { readonly device: string; readonly port: string };

export type PtLink = {
  /** CABLE/TYPE, such as eStraightThrough, or LINK/TYPE (eSerial) when the cable has none. */
  readonly cable: string;
  readonly from: PtEnd;
  readonly to: PtEnd;
  /** The serial DCE end. */
  readonly dce: PtEnd | undefined;
};

export type PtNetwork = {
  readonly version: string;
  /** True for a .pka activity, where only the first of its three networks is read. */
  readonly activity: boolean;
  readonly devices: readonly PtDevice[];
  readonly links: readonly PtLink[];
};

export type PtXmlError =
  | { readonly kind: 'invalid-xml'; readonly message: string }
  | { readonly kind: 'not-packet-tracer' };

type XmlNode = { readonly [tag: string]: unknown };

const REPEATED = new Set([
  'PACKETTRACER5',
  'DEVICE',
  'LINK',
  'MODULE',
  'SLOT',
  'PORT',
  'LINE',
  'VLAN',
]);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  parseTagValue: false,
  // Config lines are indented inside interface and line blocks.
  trimValues: false,
  isArray: (tag) => REPEATED.has(tag),
});

const isNode = (value: unknown): value is XmlNode =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const node = (value: unknown): XmlNode => (isNode(value) ? value : {});

const list = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

/** The text of an element, which fast-xml-parser stores under #text when it has attributes. */
function text(value: unknown): string {
  if (typeof value === 'string') return value;
  const inner = node(value)['#text'];
  return typeof inner === 'string' ? inner : '';
}

const value = (element: unknown) => text(element).trim();

const attribute = (element: unknown, name: string) => text(node(element)[`@${name}`]).trim();

function coordinate(element: unknown): number {
  const parsed = Number.parseFloat(value(element));
  return Number.isFinite(parsed) ? parsed : 0;
}

function readPort(element: unknown, address: readonly number[]): PtPort {
  const port = node(element);
  return {
    type: value(port.TYPE),
    address,
    power: value(port.POWER) !== 'false',
    mac: value(port.MACADDRESS),
    ip: value(port.IP),
    subnet: value(port.SUBNET),
    gateway: value(port.PORT_GATEWAY),
    dns: value(port.PORT_DNS),
    dhcp: value(port.PORT_DHCP_ENABLE) === 'true',
    description: value(port.DESCRIPTION),
  };
}

// Visiting a module's own ports before its slots lists ports in the order the running-config
// lists interfaces: GigabitEthernet0/0 to 0/2 on the board, then Serial0/3/0 in slot 3.
function readPorts(module: unknown, slots: readonly number[], out: PtPort[]): void {
  const { PORT, SLOT } = node(module);
  list(PORT).forEach((port, index) => out.push(readPort(port, [...slots, index])));
  list(SLOT).forEach((slot, index) => {
    for (const inner of list(node(slot).MODULE)) readPorts(inner, [...slots, index], out);
  });
}

function readDevice(element: unknown, index: number): PtDevice {
  const { ENGINE, WORKSPACE } = node(element);
  const engine = node(ENGINE);
  const logical = node(node(WORKSPACE).LOGICAL);
  const ports: PtPort[] = [];
  for (const module of list(engine.MODULE)) readPorts(module, [], ports);
  return {
    index,
    saveRefId: value(engine.SAVE_REF_ID),
    type: value(engine.TYPE),
    model: attribute(engine.TYPE, 'model'),
    name: value(engine.NAME),
    power: value(engine.POWER) !== 'false',
    x: coordinate(logical.X),
    y: coordinate(logical.Y),
    ports,
    runningConfig: list(node(engine.RUNNINGCONFIG).LINE).map(text),
    gateway: value(engine.GATEWAY),
    dns: value(node(engine.DNS_CLIENT).SERVER_IP),
    vlans: list(node(engine.VLANS).VLAN).map((vlan) => ({
      number: Number(attribute(vlan, 'number')),
      name: attribute(vlan, 'name'),
    })),
  };
}

function readLink(element: unknown): PtLink {
  const link = node(element);
  const cable = node(link.CABLE);
  const [fromPort = '', toPort = ''] = list(cable.PORT).map(value);
  const dceDevice = value(cable.DCEDEV);
  return {
    cable: value(cable.TYPE) || value(link.TYPE),
    from: { device: value(cable.FROM), port: fromPort },
    to: { device: value(cable.TO), port: toPort },
    dce: dceDevice ? { device: dceDevice, port: value(cable.DCEPORT) } : undefined,
  };
}

export function readPtNetwork(xml: string): Result<PtNetwork, PtXmlError> {
  let document: XmlNode;
  try {
    document = node(parser.parse(xml));
  } catch (error) {
    return err({
      kind: 'invalid-xml',
      message: error instanceof Error ? error.message : String(error),
    });
  }

  // A .pka holds three networks. The first is the user's. The second is the initial network
  // that "reset" restores and the third is the answer network, so neither is read.
  const activity = isNode(document.PACKETTRACER5_ACTIVITY);
  const root = activity ? node(document.PACKETTRACER5_ACTIVITY) : document;
  const network = node(list(root.PACKETTRACER5)[0]);
  if (!isNode(network.NETWORK)) return err({ kind: 'not-packet-tracer' });

  const { DEVICES, LINKS } = network.NETWORK;
  return ok({
    version: value(network.VERSION) || value(root.VERSION),
    activity,
    devices: list(node(DEVICES).DEVICE).map(readDevice),
    links: list(node(LINKS).LINK).map(readLink),
  });
}
