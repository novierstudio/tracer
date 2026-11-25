import { findDeviceModel, type DeviceIconName } from '@/devices/catalog';
import {
  linkAt,
  type Annotation,
  type Device,
  type DeviceKind,
  type Ipv4Cidr,
  type Link,
  type MacAddress,
  type PortId,
  type PortKind,
  type Topology,
} from '@/model';
import type { Selection } from '@/model/store';

/** What the inspector shows, derived from the selection and the topology it points into. */
export type InspectorView =
  | { kind: 'empty' }
  | { kind: 'device'; device: Device }
  | { kind: 'link'; link: Link }
  | { kind: 'annotation'; annotation: Annotation }
  | { kind: 'multi'; devices: Device[]; links: Link[]; annotations: Annotation[] };

export function inspectorView(topology: Topology, selection: Selection): InspectorView {
  const devices = selection.devices.flatMap((id) => topology.devices[id] ?? []);
  const links = selection.links.flatMap((id) => topology.links[id] ?? []);
  const annotations = selection.annotations.flatMap((id) => topology.annotations[id] ?? []);
  const [device] = devices;
  const [link] = links;
  const [annotation] = annotations;
  if (devices.length + links.length + annotations.length > 1) {
    return { kind: 'multi', devices, links, annotations };
  }
  if (device) return { kind: 'device', device };
  if (link) return { kind: 'link', link };
  if (annotation) return { kind: 'annotation', annotation };
  return { kind: 'empty' };
}

export const KIND_LABELS: Record<DeviceKind, { one: string; many: string }> = {
  router: { one: 'Router', many: 'Routers' },
  switch: { one: 'Switch', many: 'Switches' },
  pc: { one: 'PC', many: 'PCs' },
  server: { one: 'Server', many: 'Servers' },
};

const KIND_ICONS: Record<DeviceKind, DeviceIconName> = {
  router: 'router',
  switch: 'switch',
  pc: 'pc',
  server: 'server',
};

/** Catalog name and icon, falling back to the kind for models the catalog does not know. */
export function describeModel(device: Device): { name: string; icon: DeviceIconName } {
  const model = findDeviceModel(device.model);
  return { name: model?.name ?? device.model, icon: model?.icon ?? KIND_ICONS[device.kind] };
}

export const PORT_KIND_NAMES: Record<PortKind, string> = {
  fastEthernet: 'FastEthernet',
  gigabitEthernet: 'GigabitEthernet',
  serial: 'Serial',
};

const PORT_ABBREVIATIONS: Record<PortKind, string> = {
  fastEthernet: 'Fa',
  gigabitEthernet: 'Gi',
  serial: 'Se',
};

/** `GigabitEthernet0/1` → `Gi0/1`, as IOS abbreviates in `show` output. */
export function shortPortName(port: PortId): string {
  for (const kind of Object.keys(PORT_KIND_NAMES) as PortKind[]) {
    const long = PORT_KIND_NAMES[kind];
    if (port.startsWith(long)) return PORT_ABBREVIATIONS[kind] + port.slice(long.length);
  }
  return port;
}

export type Peer = { device: Device; port: PortId; link: Link };

/** Link state as the inspector can know it before the engine runs: cabled, and both ends enabled. */
export type PortState = 'up' | 'down' | 'free';

export type PortRow = {
  id: PortId;
  kind: PortKind;
  mac: MacAddress | undefined;
  peer: Peer | undefined;
  /** Routers and switches have `shutdown`; hosts do not. */
  admin: 'up' | 'down' | undefined;
  state: PortState;
} & (
  | { layer: 'routed'; ipv4: Ipv4Cidr | undefined }
  | { layer: 'host'; ipv4: Ipv4Cidr | undefined }
  | { layer: 'switched'; vlan: string }
);

function adminState(device: Device, port: PortId): 'up' | 'down' | undefined {
  if (device.kind === 'router' || device.kind === 'switch') {
    return device.config.interfaces[port]?.shutdown ? 'down' : 'up';
  }
  return undefined;
}

function enabled(device: Device, port: PortId): boolean {
  return device.powered && adminState(device, port) !== 'down';
}

export function peerOf(topology: Topology, device: Device, port: PortId): Peer | undefined {
  const link = linkAt(topology, { device: device.id, port });
  if (!link) return undefined;
  const far = link.a.device === device.id && link.a.port === port ? link.b : link.a;
  const farDevice = topology.devices[far.device];
  return farDevice && { device: farDevice, port: far.port, link };
}

export function linkState(topology: Topology, link: Link): Exclude<PortState, 'free'> {
  const ends = [link.a, link.b].map((end) => {
    const device = topology.devices[end.device];
    return device ? enabled(device, end.port) : false;
  });
  return ends.every(Boolean) ? 'up' : 'down';
}

/** The host's single address belongs to its first Ethernet port. */
function hostAddressPort(device: Device): PortId | undefined {
  return device.ports.find((port) => port.kind !== 'serial')?.id;
}

export function portRows(topology: Topology, device: Device): PortRow[] {
  const hostPort = hostAddressPort(device);
  return device.ports.map((port) => {
    const peer = peerOf(topology, device, port.id);
    const base = {
      id: port.id,
      kind: port.kind,
      mac: port.kind === 'serial' ? undefined : port.mac,
      peer,
      admin: adminState(device, port.id),
      state: peer ? linkState(topology, peer.link) : 'free',
    } as const;

    switch (device.kind) {
      case 'router':
        return { ...base, layer: 'routed', ipv4: device.config.interfaces[port.id]?.ipv4 };
      case 'switch': {
        const switchport = device.config.interfaces[port.id]?.switchport;
        const vlan = switchport?.mode === 'trunk' ? 'Trunk' : `VLAN ${switchport?.vlan ?? 1}`;
        return { ...base, layer: 'switched', vlan };
      }
      case 'pc':
      case 'server': {
        const { ipv4 } = device.config;
        const address = ipv4.mode === 'static' && port.id === hostPort ? ipv4.address : undefined;
        return { ...base, layer: 'host', ipv4: address };
      }
      default: {
        const exhaustive: never = device;
        return exhaustive;
      }
    }
  });
}

export const CABLE_LABELS: Record<Link['cable'], string> = {
  straight: 'Copper straight-through',
  crossover: 'Copper crossover',
  serial: 'Serial DCE/DTE',
};

/** "2 routers, 1 PC, 3 links and 1 annotation", in kind order. */
export function selectionSummary(
  devices: readonly Device[],
  links: readonly Link[],
  annotations: readonly Annotation[] = [],
): string {
  const counts = new Map<DeviceKind, number>();
  for (const device of devices) counts.set(device.kind, (counts.get(device.kind) ?? 0) + 1);
  const parts = (Object.keys(KIND_LABELS) as DeviceKind[]).flatMap((kind) => {
    const count = counts.get(kind);
    if (!count) return [];
    const label = KIND_LABELS[kind][count === 1 ? 'one' : 'many'];
    return [`${count} ${kind === 'pc' ? label : label.toLowerCase()}`];
  });
  if (links.length > 0) parts.push(`${links.length} ${links.length === 1 ? 'link' : 'links'}`);
  if (annotations.length > 0) {
    parts.push(`${annotations.length} ${annotations.length === 1 ? 'annotation' : 'annotations'}`);
  }
  if (parts.length < 2) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}
