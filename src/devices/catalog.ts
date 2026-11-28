import { PortId, type DeviceKind, type DeviceSpec, type PortKind, type PortSpec } from '@/model';
import { HUB_MODELS, ROUTER_MODELS, SWITCH_MODELS } from './models/routers-switches';
import { modelPorts, subslots, type ModuleMap, type Slot } from './modules';
import { WIRELESS_IOT_MODELS } from './models/wireless-iot';
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
  | 'router-isr'
  | 'router-pt'
  | 'switch'
  | 'multilayer-switch'
  | 'industrial-switch'
  | 'bridge'
  | 'repeater'
  | 'pc'
  | 'laptop'
  | 'server'
  | 'hub'
  | 'access-point'
  | 'wireless-router'
  | 'lightweight-ap'
  | 'wlc'
  | 'home-gateway'
  | 'cell-tower'
  | 'central-office'
  | 'iot-mcu'
  | 'iot-sbc'
  | 'iot-lamp'
  | 'iot-fan'
  | 'iot-door'
  | 'iot-window'
  | 'iot-motion'
  | 'iot-smoke'
  | 'iot-siren'
  | 'iot-thermostat'
  | 'iot-webcam'
  | 'iot-thing';

/** The icon for a device whose model the catalog does not know, by its kind. */
export const KIND_ICONS: Record<DeviceKind, DeviceIconName> = {
  router: 'router',
  switch: 'switch',
  pc: 'pc',
  server: 'server',
  hub: 'hub',
  accessPoint: 'access-point',
  wirelessRouter: 'wireless-router',
  lightweightAp: 'lightweight-ap',
  wlc: 'wlc',
  cellTower: 'cell-tower',
  centralOffice: 'central-office',
};

export type DeviceModel = {
  readonly id: string;
  readonly name: string;
  readonly category: DeviceCategory;
  readonly kind: DeviceKind;
  readonly hostnamePrefix: string;
  readonly icon: DeviceIconName;
  /** Onboard interfaces, as `show ip interface brief` lists them. Its modules' ports follow. */
  readonly ports: readonly PortSpec[];
  /** Module bays, in the order their ports list. */
  readonly slots?: readonly Slot[];
  /** The modules it ships with. */
  readonly modules?: ModuleMap;
  /** A multilayer switch: it takes `ip routing`, routed ports and static routes. */
  readonly multilayer?: true;
  /** A radio's band and 802.11 standards, as Packet Tracer lists them for the model. */
  readonly wifi?: { readonly band: string; readonly standards: readonly string[] };
  /** The model's factory settings, where they differ from its kind's, as a new device takes them. */
  readonly config?: DeviceSpec['config'];
};

export const DEVICE_MODELS = [
  {
    // A 1941 with an HWIC-2T, for serial links out of the box.
    id: 'router-2g2s',
    name: '1941',
    category: 'routers',
    kind: 'router',
    hostnamePrefix: 'Router',
    icon: 'router',
    ports: ports('gigabitEthernet', '0/', 0, 2),
    slots: subslots('hwic', 0, 1),
    modules: { '0/0': 'HWIC-2T' },
  },
  {
    id: 'router-4g',
    name: '2911',
    category: 'routers',
    kind: 'router',
    hostnamePrefix: 'Router',
    icon: 'router',
    ports: ports('gigabitEthernet', '0/', 0, 3),
    slots: subslots('hwic', 0, 3),
  },
  ...ROUTER_MODELS,
  {
    id: 'switch-24',
    name: '2960-24TT',
    category: 'switches',
    kind: 'switch',
    hostnamePrefix: 'Switch',
    icon: 'switch',
    ports: [...ports('fastEthernet', '0/', 1, 24), ...ports('gigabitEthernet', '0/', 1, 2)],
  },
  {
    id: 'switch-48',
    // Packet Tracer has no 48-port 2960; this one stays for labs that use it.
    name: '2960-48TT',
    category: 'switches',
    kind: 'switch',
    hostnamePrefix: 'Switch',
    icon: 'switch',
    ports: [...ports('fastEthernet', '0/', 1, 48), ...ports('gigabitEthernet', '0/', 1, 2)],
  },
  {
    id: 'switch-24-fiber',
    name: '2960-24TT Fiber',
    category: 'switches',
    kind: 'switch',
    hostnamePrefix: 'Switch',
    icon: 'switch',
    // Fiber uplinks, as a 2960 with SFP modules: they take a fiber cable only.
    ports: [...ports('fastEthernet', '0/', 1, 24), ...fiber(ports('gigabitEthernet', '0/', 1, 2))],
  },
  {
    id: 'switch-l3-24',
    name: '3560-24PS',
    category: 'switches',
    kind: 'switch',
    hostnamePrefix: 'Switch',
    icon: 'multilayer-switch',
    ports: [...ports('fastEthernet', '0/', 1, 24), ...ports('gigabitEthernet', '0/', 1, 2)],
    multilayer: true,
  },
  ...SWITCH_MODELS,
  {
    id: 'hub',
    name: 'Hub-PT',
    category: 'hubs',
    kind: 'hub',
    hostnamePrefix: 'Hub',
    icon: 'hub',
    ports: numbered(6),
  },
  ...HUB_MODELS,
  {
    id: 'access-point',
    name: 'AccessPoint-PT',
    category: 'wireless',
    kind: 'accessPoint',
    hostnamePrefix: 'AccessPoint',
    icon: 'access-point',
    // As Packet Tracer's AccessPoint-PT: Port 0 is Ethernet, Port 1 the radio.
    ports: [...numbered(1), radio('Port1')],
  },
  {
    id: 'wireless-router',
    name: 'WRT300N',
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
    name: 'PC-PT',
    category: 'end-devices',
    kind: 'pc',
    hostnamePrefix: 'PC',
    icon: 'pc',
    ports: single('fastEthernet'),
  },
  {
    id: 'laptop',
    name: 'Laptop-PT',
    category: 'end-devices',
    kind: 'pc',
    hostnamePrefix: 'Laptop',
    icon: 'laptop',
    ports: single('gigabitEthernet'),
  },
  {
    id: 'server',
    name: 'Server-PT',
    category: 'end-devices',
    kind: 'server',
    hostnamePrefix: 'Server',
    icon: 'server',
    ports: single('gigabitEthernet'),
  },
  ...WIRELESS_IOT_MODELS,
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

const BY_NAME = new Map<string, DeviceModel>(DEVICE_MODELS.map((model) => [model.name, model]));

/** The model Packet Tracer calls `name`, such as 2911 or Switch-PT. */
export function findDeviceModelByName(name: string): DeviceModel | undefined {
  return BY_NAME.get(name);
}

/** Whether a device of model `id` can route, as only multilayer switches and routers can. */
export const isMultilayerSwitch = (id: string): boolean => findDeviceModel(id)?.multilayer === true;

const PORT_ABBREVIATION: Record<PortKind, string> = {
  fastEthernet: 'Fa',
  gigabitEthernet: 'Gi',
  serial: 'Serial',
  wireless: 'Wireless',
};

/** "2× Gi, 2× Serial", in the order the kinds first appear. Fiber, coaxial and 3G/4G ports say so. */
export function portSummary(model: DeviceModel): string {
  const counts = new Map<string, number>();
  for (const port of modelPorts(model)) {
    const name = port.coaxial
      ? 'Coaxial'
      : port.cellular
        ? '3G/4G'
        : `${PORT_ABBREVIATION[port.kind]}${port.fiber ? ' fiber' : ''}`;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  if (counts.size === 0) return 'No ports';
  return [...counts].map(([name, count]) => `${count}× ${name}`).join(', ');
}
