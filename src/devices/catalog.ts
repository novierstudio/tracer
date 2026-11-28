import { PortId, type DeviceKind, type PortKind, type PortSpec } from '@/model';
import { fiber, numbered, ports, radio, single } from './ports';

export { WIRELESS_NIC } from './ports';

/** Packet Tracer's palette groups, each with its categories in palette order. */
export const DEVICE_GROUPS = [
  {
    label: 'Network Devices',
    categories: ['routers', 'switches', 'hubs', 'wireless', 'security', 'wan-emulation'],
  },
  {
    label: 'End Devices',
    categories: ['end-devices', 'home', 'smart-city', 'industrial', 'power-grid'],
  },
  { label: 'Components', categories: ['components'] },
] as const;
export type DeviceGroup = (typeof DEVICE_GROUPS)[number];

export const DEVICE_CATEGORIES = DEVICE_GROUPS.flatMap((group) => group.categories);
export type DeviceCategory = DeviceGroup['categories'][number];

export const CATEGORY_LABELS: Record<DeviceCategory, string> = {
  routers: 'Routers',
  switches: 'Switches',
  hubs: 'Hubs',
  wireless: 'Wireless Devices',
  security: 'Security',
  'wan-emulation': 'WAN Emulation',
  'end-devices': 'End Devices',
  home: 'Home',
  'smart-city': 'Smart City',
  industrial: 'Industrial',
  'power-grid': 'Power Grid',
  components: 'Components',
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
    category: 'end-devices',
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
