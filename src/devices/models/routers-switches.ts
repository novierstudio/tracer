// Packet Tracer's routers, switches and hubs, beyond the first few in the catalog. Each lists its
// onboard interfaces as `show ip interface brief` does on a new one; its modules' ports follow.

import type { DeviceModel } from '../catalog';
import { nmSlot, ptSlots, subslots, WIC_2600_SLOTS, type Slot } from '../modules';
import { numbered, ports } from '../ports';

const ROUTER = { category: 'routers', kind: 'router', hostnamePrefix: 'Router' } as const;
const SWITCH = { category: 'switches', kind: 'switch', hostnamePrefix: 'Switch' } as const;

/** A 3650's four uplinks, Gi1/1/1 to Gi1/1/4: SFP cages that take a GLC-LH-SMD each. */
const SFP_3650: readonly Slot[] = [1, 2, 3, 4].map((n) => ({
  id: `1/1/${n}`,
  bay: 'sfp',
  prefix: '1/1/',
  first: n,
}));

export const ROUTER_MODELS = [
  {
    ...ROUTER,
    id: 'router-isr4331',
    name: 'ISR4331',
    icon: 'router-isr',
    ports: ports('gigabitEthernet', '0/0/', 0, 3),
    slots: subslots('nim', 1, 2),
  },
  {
    ...ROUTER,
    id: 'router-isr4321',
    name: 'ISR4321',
    icon: 'router-isr',
    ports: ports('gigabitEthernet', '0/0/', 0, 2),
    slots: subslots('nim', 1, 2),
  },
  {
    ...ROUTER,
    id: 'router-2901',
    name: '2901',
    icon: 'router',
    ports: ports('gigabitEthernet', '0/', 0, 2),
    slots: subslots('hwic', 0, 3),
  },
  {
    ...ROUTER,
    id: 'router-819hgw',
    name: '819HGW',
    icon: 'router',
    ports: [
      ...ports('fastEthernet', '', 0, 4),
      ...ports('gigabitEthernet', '', 0, 1),
      ...ports('serial', '', 0, 1),
    ],
  },
  {
    ...ROUTER,
    id: 'router-829',
    name: '829',
    icon: 'router',
    ports: ports('gigabitEthernet', '', 0, 5),
  },
  {
    ...ROUTER,
    id: 'router-pt',
    name: 'Router-PT',
    icon: 'router-pt',
    ports: [],
    slots: ptSlots('pt-router'),
    modules: {
      0: 'PT-ROUTER-NM-1CFE',
      1: 'PT-ROUTER-NM-1CFE',
      2: 'PT-ROUTER-NM-1S',
      3: 'PT-ROUTER-NM-1S',
      4: 'PT-ROUTER-NM-1FFE',
      5: 'PT-ROUTER-NM-1FFE',
    },
  },
  {
    ...ROUTER,
    id: 'router-pt-empty',
    name: 'Router-PT-Empty',
    icon: 'router-pt',
    ports: [],
    slots: ptSlots('pt-router'),
  },
  {
    ...ROUTER,
    id: 'router-1841',
    name: '1841',
    icon: 'router',
    ports: ports('fastEthernet', '0/', 0, 2),
    slots: subslots('hwic', 0, 1),
  },
  {
    ...ROUTER,
    id: 'router-2620xm',
    name: '2620XM',
    icon: 'router',
    ports: ports('fastEthernet', '0/', 0, 1),
    slots: [...WIC_2600_SLOTS, nmSlot(1)],
  },
  {
    ...ROUTER,
    id: 'router-2621xm',
    name: '2621XM',
    icon: 'router',
    ports: ports('fastEthernet', '0/', 0, 2),
    slots: [...WIC_2600_SLOTS, nmSlot(1)],
  },
  {
    ...ROUTER,
    id: 'router-2811',
    name: '2811',
    icon: 'router',
    ports: ports('fastEthernet', '0/', 0, 2),
    slots: [...subslots('hwic', 0, 3), nmSlot(1)],
  },
] as const satisfies readonly DeviceModel[];

export const SWITCH_MODELS = [
  {
    ...SWITCH,
    id: 'switch-3650-24ps',
    name: '3650-24PS',
    icon: 'multilayer-switch',
    ports: ports('gigabitEthernet', '1/0/', 1, 24),
    slots: SFP_3650,
    modules: {
      '1/1/1': 'GLC-LH-SMD',
      '1/1/2': 'GLC-LH-SMD',
      '1/1/3': 'GLC-LH-SMD',
      '1/1/4': 'GLC-LH-SMD',
    },
    multilayer: true,
  },
  {
    ...SWITCH,
    id: 'switch-2950-24',
    name: '2950-24',
    icon: 'switch',
    ports: ports('fastEthernet', '0/', 1, 24),
  },
  {
    ...SWITCH,
    id: 'switch-2950t-24',
    name: '2950T-24',
    icon: 'switch',
    ports: [...ports('fastEthernet', '0/', 1, 24), ...ports('gigabitEthernet', '0/', 1, 2)],
  },
  {
    ...SWITCH,
    id: 'switch-ie2000',
    name: 'IE-2000',
    icon: 'industrial-switch',
    ports: [...ports('fastEthernet', '1/', 1, 8), ...ports('gigabitEthernet', '1/', 1, 2)],
  },
  {
    ...SWITCH,
    id: 'switch-pt',
    name: 'Switch-PT',
    icon: 'switch',
    ports: [],
    slots: ptSlots('pt-switch'),
    modules: {
      0: 'PT-SWITCH-NM-1CFE',
      1: 'PT-SWITCH-NM-1CFE',
      2: 'PT-SWITCH-NM-1CFE',
      3: 'PT-SWITCH-NM-1CFE',
      4: 'PT-SWITCH-NM-1FFE',
      5: 'PT-SWITCH-NM-1FFE',
    },
  },
  {
    ...SWITCH,
    id: 'switch-pt-empty',
    name: 'Switch-PT-Empty',
    icon: 'switch',
    ports: [],
    slots: ptSlots('pt-switch'),
  },
  {
    // A two-port learning bridge with nothing to configure. Tracer forwards as a hub does.
    id: 'bridge-pt',
    name: 'Bridge-PT',
    category: 'switches',
    kind: 'hub',
    hostnamePrefix: 'Bridge',
    icon: 'bridge',
    ports: numbered(2),
  },
] as const satisfies readonly DeviceModel[];

export const HUB_MODELS = [
  {
    id: 'repeater-pt',
    name: 'Repeater-PT',
    category: 'hubs',
    kind: 'hub',
    hostnamePrefix: 'Repeater',
    icon: 'repeater',
    ports: numbered(2),
  },
] as const satisfies readonly DeviceModel[];
