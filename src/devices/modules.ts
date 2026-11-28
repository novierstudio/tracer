import { PortId, type Device, type Port, type PortKind, type PortSpec } from '@/model';
import type { DeviceModel } from './catalog';

/** The kinds of module bay a chassis has. A module fits the bays it names. */
export const BAY_LABELS = {
  wic: 'WIC',
  hwic: 'HWIC',
  nm: 'NM',
  nim: 'NIM',
  sfp: 'SFP',
  'pt-router': 'PT router module',
  'pt-switch': 'PT switch module',
} as const;
export type Bay = keyof typeof BAY_LABELS;

/**
 * A module bay. A module's ports are named `<type><prefix><n>`, numbered from `first`: an HWIC in
 * slot 0/1 has Serial0/1/0 and Serial0/1/1, and a Switch-PT module in slot 2 has FastEthernet2/1.
 */
export type Slot = {
  readonly id: string;
  readonly bay: Bay;
  readonly prefix: string;
  readonly first: number;
};

type ModulePort = { readonly kind: PortKind; readonly fiber?: true };

export type ModuleSpec = {
  readonly id: string;
  readonly description: string;
  readonly bays: readonly Bay[];
  readonly ports: readonly ModulePort[];
};

const serial = (count: number): ModulePort[] => Array(count).fill({ kind: 'serial' });
const fast = (count: number): ModulePort[] => Array(count).fill({ kind: 'fastEthernet' });
const FAST_FIBER: ModulePort = { kind: 'fastEthernet', fiber: true };
const GIGABIT: ModulePort = { kind: 'gigabitEthernet' };
const GIGABIT_FIBER: ModulePort = { kind: 'gigabitEthernet', fiber: true };

const WIC_BAYS: readonly Bay[] = ['wic', 'hwic'];

/** Packet Tracer's modules with network ports, as its Physical tab lists them. */
export const MODULES = [
  {
    id: 'HWIC-2T',
    description: '2-port serial high-speed WAN interface card',
    bays: ['hwic'],
    ports: serial(2),
  },
  {
    id: 'HWIC-4ESW',
    description: '4-port Fast Ethernet card',
    bays: ['hwic'],
    ports: fast(4),
  },
  {
    id: 'HWIC-1GE-SFP',
    description: '1-port Gigabit Ethernet SFP card, with a fiber SFP fitted',
    bays: ['hwic'],
    ports: [GIGABIT_FIBER],
  },
  {
    id: 'WIC-1T',
    description: '1-port serial WAN interface card',
    bays: WIC_BAYS,
    ports: serial(1),
  },
  {
    id: 'WIC-2T',
    description: '2-port serial WAN interface card',
    bays: WIC_BAYS,
    ports: serial(2),
  },
  {
    id: 'NM-1FE-TX',
    description: '1-port Fast Ethernet network module',
    bays: ['nm'],
    ports: fast(1),
  },
  {
    id: 'NM-1FE2W',
    description: '1-port Fast Ethernet network module with two WIC slots',
    bays: ['nm'],
    ports: fast(1),
  },
  {
    id: 'NM-2FE2W',
    description: '2-port Fast Ethernet network module with two WIC slots',
    bays: ['nm'],
    ports: fast(2),
  },
  {
    id: 'NM-4A/S',
    description: '4-port synchronous serial network module',
    bays: ['nm'],
    ports: serial(4),
  },
  {
    id: 'NM-8A/S',
    description: '8-port synchronous serial network module',
    bays: ['nm'],
    ports: serial(8),
  },
  {
    id: 'NIM-2T',
    description: '2-port serial network interface module',
    bays: ['nim'],
    ports: serial(2),
  },
  {
    id: 'GLC-LH-SMD',
    description: '1000BASE-LX/LH single-mode fiber SFP',
    bays: ['sfp'],
    ports: [GIGABIT_FIBER],
  },
  {
    id: 'PT-ROUTER-NM-1CFE',
    description: 'Copper Fast Ethernet',
    bays: ['pt-router'],
    ports: fast(1),
  },
  {
    id: 'PT-ROUTER-NM-1CGE',
    description: 'Copper Gigabit Ethernet',
    bays: ['pt-router'],
    ports: [GIGABIT],
  },
  {
    id: 'PT-ROUTER-NM-1FFE',
    description: 'Fiber Fast Ethernet',
    bays: ['pt-router'],
    ports: [FAST_FIBER],
  },
  {
    id: 'PT-ROUTER-NM-1FGE',
    description: 'Fiber Gigabit Ethernet',
    bays: ['pt-router'],
    ports: [GIGABIT_FIBER],
  },
  { id: 'PT-ROUTER-NM-1S', description: 'Serial', bays: ['pt-router'], ports: serial(1) },
  {
    id: 'PT-ROUTER-NM-1SS',
    description: 'Dual-port serial',
    bays: ['pt-router'],
    ports: serial(2),
  },
  {
    id: 'PT-SWITCH-NM-1CFE',
    description: 'Copper Fast Ethernet',
    bays: ['pt-switch'],
    ports: fast(1),
  },
  {
    id: 'PT-SWITCH-NM-1CGE',
    description: 'Copper Gigabit Ethernet',
    bays: ['pt-switch'],
    ports: [GIGABIT],
  },
  {
    id: 'PT-SWITCH-NM-1FFE',
    description: 'Fiber Fast Ethernet',
    bays: ['pt-switch'],
    ports: [FAST_FIBER],
  },
  {
    id: 'PT-SWITCH-NM-1FGE',
    description: 'Fiber Gigabit Ethernet',
    bays: ['pt-switch'],
    ports: [GIGABIT_FIBER],
  },
] as const satisfies readonly ModuleSpec[];

export type ModuleId = (typeof MODULES)[number]['id'];

/** Which module sits in each slot, by slot id. An empty slot is left out. */
export type ModuleMap = Readonly<Partial<Record<string, ModuleId>>>;

const BY_ID = new Map<string, ModuleSpec>(MODULES.map((module) => [module.id, module]));

export const findModule = (id: string): ModuleSpec | undefined => BY_ID.get(id);

export const compatibleModules = (slot: Slot): ModuleSpec[] =>
  MODULES.filter((module) => (module.bays as readonly Bay[]).includes(slot.bay));

const PORT_PREFIX: Record<PortKind, string> = {
  fastEthernet: 'FastEthernet',
  gigabitEthernet: 'GigabitEthernet',
  serial: 'Serial',
  wireless: 'Wireless',
};

/** The ports `module` gives a device in `slot`. */
export function slotPorts(slot: Slot, module: string | undefined): PortSpec[] {
  const spec = module === undefined ? undefined : findModule(module);
  return (spec?.ports ?? []).map(({ kind, fiber }, i) => ({
    kind,
    id: PortId.parse(`${PORT_PREFIX[kind]}${slot.prefix}${slot.first + i}`),
    ...(fiber && { fiber }),
  }));
}

/** A model's ports with `modules` fitted: its onboard ports, then each slot's in slot order. */
export function modelPorts(
  model: DeviceModel,
  modules: ModuleMap = model.modules ?? {},
): PortSpec[] {
  return [
    ...model.ports,
    ...(model.slots ?? []).flatMap((slot) => slotPorts(slot, modules[slot.id])),
  ];
}

const portSpec = (port: Port): PortSpec => ({
  kind: port.kind,
  id: port.id,
  ...(port.kind !== 'serial' && 'fiber' in port && port.fiber && { fiber: true }),
});

/** The modules in a device. A file from before modules has the ones its model ships with. */
export const installedModules = (device: Device, model: DeviceModel): ModuleMap =>
  (device.modules as ModuleMap | undefined) ?? model.modules ?? {};

/**
 * A device's ports once `modules` replace the ones it has. Its onboard ports stay as the device
 * has them, so a device saved before its model changed keeps them.
 */
export function portsWithModules(
  device: Device,
  model: DeviceModel,
  modules: ModuleMap,
): PortSpec[] {
  const slots = model.slots ?? [];
  const current = installedModules(device, model);
  const fitted = new Set(
    slots.flatMap((slot) => slotPorts(slot, current[slot.id])).map((p) => p.id),
  );
  const onboard = device.ports.filter((port) => !fitted.has(port.id)).map(portSpec);
  return [...onboard, ...slots.flatMap((slot) => slotPorts(slot, modules[slot.id]))];
}

/**
 * The modules that give a device exactly the ports it has in each slot, as for a Packet Tracer
 * file, which lists ports but not modules. A slot no module fits is left empty.
 */
export function inferModules(model: DeviceModel, ports: readonly PortSpec[]): ModuleMap {
  const byId = new Map(ports.map((port) => [port.id as string, port]));
  const modules: Partial<Record<string, ModuleId>> = {};
  for (const slot of model.slots ?? []) {
    const fits = compatibleModules(slot)
      .map((module) => ({ module, wanted: slotPorts(slot, module.id) }))
      .filter(({ wanted }) =>
        wanted.every((want) => {
          const port = byId.get(want.id);
          return port?.kind === want.kind && Boolean(port.fiber) === Boolean(want.fiber);
        }),
      )
      .sort((a, b) => b.wanted.length - a.wanted.length);
    const [best] = fits;
    if (best && best.wanted.length > 0) modules[slot.id] = best.module.id as ModuleId;
  }
  return modules;
}

/** Writes a module map as a device stores it, with empty slots left out. */
export const storedModules = (modules: ModuleMap): Record<string, string> =>
  Object.fromEntries(
    Object.entries(modules).filter((entry): entry is [string, ModuleId] => entry[1] !== undefined),
  );

/** Slots `<slot>/<from>` to `<slot>/<to>` of one bay kind, as an ISR's HWIC or NIM slots. */
export const subslots = (bay: Bay, from: number, to: number, slot = 0): Slot[] =>
  Array.from({ length: to - from + 1 }, (_, i) => ({
    id: `${slot}/${from + i}`,
    bay,
    prefix: `${slot}/${from + i}/`,
    first: 0,
  }));

/** A network module slot: an NM in slot 1 has FastEthernet1/0. */
export const nmSlot = (slot: number): Slot => ({
  id: String(slot),
  bay: 'nm',
  prefix: `${slot}/`,
  first: 0,
});

/** A 2600's two WIC slots. Their ports count on from slot 0: slot 1 starts at Serial0/2. */
export const WIC_2600_SLOTS: readonly Slot[] = [
  { id: '0/0', bay: 'wic', prefix: '0/', first: 0 },
  { id: '0/1', bay: 'wic', prefix: '0/', first: 2 },
];

/** Router-PT's and Switch-PT's ten slots. A Switch-PT numbers ports from 1, as switches do. */
export const ptSlots = (bay: 'pt-router' | 'pt-switch'): Slot[] =>
  Array.from({ length: 10 }, (_, i) => ({
    id: String(i),
    bay,
    prefix: `${i}/`,
    first: bay === 'pt-switch' ? 1 : 0,
  }));
