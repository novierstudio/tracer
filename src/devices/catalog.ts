import { PortId, type DeviceKind, type PortKind } from '@/model';
import type { PortSpec } from '@/model';

export const DEVICE_CATEGORIES = [
  'routers',
  'switches',
  'hubs',
  'wireless',
  'end-devices',
  'servers',
] as const;
export type DeviceCategory = (typeof DEVICE_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<DeviceCategory, string> = {
  routers: 'Routers',
  switches: 'Switches',
  hubs: 'Hubs',
  wireless: 'Wireless devices',
  'end-devices': 'End devices',
  servers: 'Servers',
};

export type DeviceIconName =
  | 'router'
  | 'switch'
  | 'multilayer-switch'
  | 'pc'
  | 'laptop'
  | 'server'
  | 'hub'
  | 'access-point'
  | 'wireless-router';

/** The icon for a device whose model the catalog does not know, by its kind. */
export const KIND_ICONS: Record<DeviceKind, DeviceIconName> = {
  router: 'router',
  switch: 'switch',
  pc: 'pc',
  server: 'server',
  hub: 'hub',
  accessPoint: 'access-point',
  wirelessRouter: 'wireless-router',
};

export type DeviceModel = {
  readonly id: string;
  readonly name: string;
  readonly category: DeviceCategory;
  readonly kind: DeviceKind;
  readonly hostnamePrefix: string;
  readonly icon: DeviceIconName;
  /** Interfaces in module/slot order, as `show ip interface brief` lists them. */
  readonly ports: readonly PortSpec[];
  /** A multilayer switch: it takes `ip routing`, routed ports and static routes. */
  readonly multilayer?: true;
};

const PORT_PREFIX: Record<PortKind, string> = {
  fastEthernet: 'FastEthernet',
  gigabitEthernet: 'GigabitEthernet',
  serial: 'Serial',
  wireless: 'Wireless',
};

/** `ports('gigabitEthernet', '0/', 0, 2)` is GigabitEthernet0/0 and GigabitEthernet0/1. */
function ports(kind: PortKind, slot: string, first: number, count: number): PortSpec[] {
  return Array.from({ length: count }, (_, i) => ({
    kind,
    id: PortId.parse(`${PORT_PREFIX[kind]}${slot}${first + i}`),
  }));
}

const fiber = (specs: PortSpec[]): PortSpec[] => specs.map((spec) => ({ ...spec, fiber: true }));

/** Packet Tracer's `Port 0`, `Port 1`, …: how a hub names its ports. */
const numbered = (count: number): PortSpec[] =>
  Array.from({ length: count }, (_, i) => ({
    kind: 'fastEthernet',
    id: PortId.parse(`Port${i}`),
  }));

const radio = (name: string): PortSpec => ({ kind: 'wireless', id: PortId.parse(name) });

/** The radio a PC or laptop takes in place of its Ethernet card, as Packet Tracer's WMP300N. */
export const WIRELESS_NIC: PortSpec = radio('Wireless0');

const single = (kind: PortKind): PortSpec[] => [
  { kind, id: PortId.parse(`${PORT_PREFIX[kind]}0`) },
];

export const DEVICE_MODELS = [
  {
    id: 'router-2g2s',
    name: 'Branch Router',
    category: 'routers',
    kind: 'router',
    hostnamePrefix: 'Router',
    icon: 'router',
    ports: [...ports('gigabitEthernet', '0/', 0, 2), ...ports('serial', '0/0/', 0, 2)],
  },
  {
    id: 'router-4g',
    name: 'Edge Router',
    category: 'routers',
    kind: 'router',
    hostnamePrefix: 'Router',
    icon: 'router',
    ports: ports('gigabitEthernet', '0/', 0, 4),
  },
  {
    id: 'switch-24',
    name: 'Access Switch 24',
    category: 'switches',
    kind: 'switch',
    hostnamePrefix: 'Switch',
    icon: 'switch',
    ports: [...ports('fastEthernet', '0/', 1, 24), ...ports('gigabitEthernet', '0/', 1, 2)],
  },
  {
    id: 'switch-48',
    name: 'Access Switch 48',
    category: 'switches',
    kind: 'switch',
    hostnamePrefix: 'Switch',
    icon: 'switch',
    ports: [...ports('fastEthernet', '0/', 1, 48), ...ports('gigabitEthernet', '0/', 1, 2)],
  },
  {
    id: 'switch-24-fiber',
    name: 'Access Switch 24 Fiber',
    category: 'switches',
    kind: 'switch',
    hostnamePrefix: 'Switch',
    icon: 'switch',
    // Fiber uplinks, as a 2960 with SFP modules: they take a fiber cable only.
    ports: [...ports('fastEthernet', '0/', 1, 24), ...fiber(ports('gigabitEthernet', '0/', 1, 2))],
  },
  {
    id: 'switch-l3-24',
    name: 'Multilayer Switch 24',
    category: 'switches',
    kind: 'switch',
    hostnamePrefix: 'Switch',
    icon: 'multilayer-switch',
    ports: [...ports('fastEthernet', '0/', 1, 24), ...ports('gigabitEthernet', '0/', 1, 2)],
    multilayer: true,
  },
  {
    id: 'hub',
    name: 'Hub',
    category: 'hubs',
    kind: 'hub',
    hostnamePrefix: 'Hub',
    icon: 'hub',
    ports: numbered(6),
  },
  {
    id: 'access-point',
    name: 'Access Point',
    category: 'wireless',
    kind: 'accessPoint',
    hostnamePrefix: 'AccessPoint',
    icon: 'access-point',
    // As Packet Tracer's AccessPoint-PT: Port 0 is Ethernet, Port 1 the radio.
    ports: [...numbered(1), radio('Port1')],
  },
  {
    id: 'wireless-router',
    name: 'Wireless Router',
    category: 'wireless',
    kind: 'wirelessRouter',
    hostnamePrefix: 'WirelessRouter',
    icon: 'wireless-router',
    // As Packet Tracer's WRT300N: the Internet port, four LAN ports and the radio.
    ports: [
      { kind: 'fastEthernet', id: PortId.parse('Internet') },
      ...[1, 2, 3, 4].map((n): PortSpec => ({
        kind: 'fastEthernet',
        id: PortId.parse(`Ethernet${n}`),
      })),
      radio('Wireless'),
    ],
  },
  {
    id: 'pc',
    name: 'Desktop PC',
    category: 'end-devices',
    kind: 'pc',
    hostnamePrefix: 'PC',
    icon: 'pc',
    ports: single('fastEthernet'),
  },
  {
    id: 'laptop',
    name: 'Laptop',
    category: 'end-devices',
    kind: 'pc',
    hostnamePrefix: 'Laptop',
    icon: 'laptop',
    ports: single('gigabitEthernet'),
  },
  {
    id: 'server',
    name: 'Server',
    category: 'servers',
    kind: 'server',
    hostnamePrefix: 'Server',
    icon: 'server',
    ports: single('gigabitEthernet'),
  },
] as const satisfies readonly DeviceModel[];

export type DeviceModelId = (typeof DEVICE_MODELS)[number]['id'];

const BY_ID = new Map<string, DeviceModel>(DEVICE_MODELS.map((model) => [model.id, model]));

export function deviceModel(id: DeviceModelId): DeviceModel {
  return BY_ID.get(id)!;
}

/** For ids from outside the type system: a drop payload or an imported file. */
export function findDeviceModel(id: string): DeviceModel | undefined {
  return BY_ID.get(id);
}

/** Whether a device of model `id` can route, as only multilayer switches and routers can. */
export const isMultilayerSwitch = (id: string): boolean => findDeviceModel(id)?.multilayer === true;

const PORT_ABBREVIATION: Record<PortKind, string> = {
  fastEthernet: 'Fa',
  gigabitEthernet: 'Gi',
  serial: 'Serial',
  wireless: 'Wireless',
};

/** "2× Gi, 2× Serial", in the order the kinds first appear. Fiber ports say so. */
export function portSummary(model: DeviceModel): string {
  const counts = new Map<string, number>();
  for (const port of model.ports) {
    const name = `${PORT_ABBREVIATION[port.kind]}${port.fiber ? ' fiber' : ''}`;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts].map(([name, count]) => `${count}× ${name}`).join(', ');
}
