import { PortId, type DeviceKind, type PortKind } from '@/model';
import type { PortSpec } from '@/model';

export const DEVICE_CATEGORIES = ['routers', 'switches', 'end-devices', 'servers'] as const;
export type DeviceCategory = (typeof DEVICE_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<DeviceCategory, string> = {
  routers: 'Routers',
  switches: 'Switches',
  'end-devices': 'End devices',
  servers: 'Servers',
};

export type DeviceIconName = 'router' | 'switch' | 'pc' | 'laptop' | 'server';

export type DeviceModel = {
  readonly id: string;
  readonly name: string;
  readonly category: DeviceCategory;
  readonly kind: DeviceKind;
  readonly hostnamePrefix: string;
  readonly icon: DeviceIconName;
  /** Interfaces in module/slot order, as `show ip interface brief` lists them. */
  readonly ports: readonly PortSpec[];
};

const PORT_PREFIX: Record<PortKind, string> = {
  fastEthernet: 'FastEthernet',
  gigabitEthernet: 'GigabitEthernet',
  serial: 'Serial',
};

/** `ports('gigabitEthernet', '0/', 0, 2)` is GigabitEthernet0/0 and GigabitEthernet0/1. */
function ports(kind: PortKind, slot: string, first: number, count: number): PortSpec[] {
  return Array.from({ length: count }, (_, i) => ({
    kind,
    id: PortId.parse(`${PORT_PREFIX[kind]}${slot}${first + i}`),
  }));
}

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

const PORT_ABBREVIATION: Record<PortKind, string> = {
  fastEthernet: 'Fa',
  gigabitEthernet: 'Gi',
  serial: 'Serial',
};

/** "2× Gi, 2× Serial", in the order the kinds first appear. */
export function portSummary(model: DeviceModel): string {
  const counts = new Map<PortKind, number>();
  for (const port of model.ports) counts.set(port.kind, (counts.get(port.kind) ?? 0) + 1);
  return [...counts].map(([kind, count]) => `${count}× ${PORT_ABBREVIATION[kind]}`).join(', ');
}
