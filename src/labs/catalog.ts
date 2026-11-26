import type { DeviceKind } from '@/model';

export type Difficulty = 'beginner' | 'intermediate';

export type SampleLab = {
  id: string;
  /** Also the lab's name once it opens, which is how the checklist finds it. */
  title: string;
  description: string;
  difficulty: Difficulty;
  /** How many of each kind of device the lab has, for the gallery card. */
  devices: Partial<Record<DeviceKind, number>>;
  /** Things to try, in order. Text in backticks is something to type. */
  tryThis: readonly string[];
  /** The `.tracer.json` text, fetched on demand so the labs stay out of the main bundle. */
  load: () => Promise<string>;
};

const text = (module: { default: string }) => module.default;

export const SAMPLE_LABS: readonly SampleLab[] = [
  {
    id: 'two-pcs-switch',
    title: 'Two PCs and a switch',
    description:
      'The smallest network that works. Two PCs share one subnet, and the switch learns where each one is from the frames it forwards. No router needed.',
    difficulty: 'beginner',
    devices: { switch: 1, pc: 2 },
    tryThis: [
      'Ping PC2 (192.168.1.11) from PC1’s Command Prompt',
      'Run `arp -a` on PC1 to see the MAC address it learned',
      'Run `show mac address-table` on SW1',
      'Change PC2’s address to 192.168.2.11 in the inspector and ping again',
    ],
    load: () => import('./two-pcs-switch.tracer.json?raw').then(text),
  },
  {
    id: 'two-lans-router',
    title: 'Two LANs and a router',
    description:
      'Two switched LANs joined by one router. Each PC sends traffic for the other LAN to its default gateway, and the router forwards it across.',
    difficulty: 'beginner',
    devices: { router: 1, switch: 2, pc: 4 },
    tryThis: [
      'Ping PC3 (192.168.2.10) from PC1’s Command Prompt',
      'Run `ipconfig` on PC1 and find its default gateway',
      'Run `show ip route` on R1: both LANs are directly connected',
      'Clear PC1’s default gateway in the inspector, then ping PC3 again',
    ],
    load: () => import('./two-lans-router.tracer.json?raw').then(text),
  },
  {
    id: 'static-routes-serial',
    title: 'Static routing',
    description:
      'Two routers joined by a serial cable, each with a LAN behind it. Neither router knows the far LAN until a static route tells it the way.',
    difficulty: 'intermediate',
    devices: { router: 2, pc: 2 },
    tryThis: [
      'Ping PC2 (192.168.2.10) from PC1’s Command Prompt',
      'Run `show ip route` on R1 and find the static route, marked S',
      'Run `show interfaces serial0/0/0` on R2',
      'On R2, enter `no ip route 192.168.1.0 255.255.255.0 10.0.0.1` in config mode and ping again',
    ],
    load: () => import('./static-routes-serial.tracer.json?raw').then(text),
  },
  {
    id: 'router-on-a-stick',
    title: 'Router on a stick',
    description:
      'One switch carries two VLANs, Sales and Staff. A single trunk takes both to the router, which routes between them on two subinterfaces.',
    difficulty: 'intermediate',
    devices: { router: 1, switch: 1, pc: 4 },
    tryThis: [
      'Ping PC3 (192.168.20.10, VLAN 20) from PC1 (VLAN 10)',
      'Run `show vlan brief` on SW1',
      'Run `show interfaces trunk` on SW1',
      'Run `show ip interface brief` on R1 to see its subinterfaces',
    ],
    load: () => import('./router-on-a-stick.tracer.json?raw').then(text),
  },
  {
    id: 'stp-triangle',
    title: 'Spanning tree triangle',
    description:
      'Three switches cabled in a loop. Spanning tree elects SW1 as the root and blocks one port, so frames cannot circle forever.',
    difficulty: 'intermediate',
    devices: { switch: 3, pc: 2 },
    tryThis: [
      'Find the port whose light stays amber: spanning tree blocks it',
      'Run `show spanning-tree` on SW2 and SW3 to find the BLK port',
      'Ping PC2 (192.168.1.11) from PC1’s Command Prompt',
      'Shut down SW1’s GigabitEthernet0/2 and watch the blocked port take over',
    ],
    load: () => import('./stp-triangle.tracer.json?raw').then(text),
  },
  {
    id: 'dhcp-router',
    title: 'DHCP on a router',
    description:
      'R1 hands out addresses from a DHCP pool. Neither PC has an address typed in: each asks for one when its cable comes up, and gets a gateway and a DNS server with it.',
    difficulty: 'beginner',
    devices: { router: 1, switch: 1, pc: 2 },
    tryThis: [
      'Run `ipconfig /all` on PC1 to see its lease and the server that gave it',
      'Run `show ip dhcp binding` on R1',
      'Switch to Simulation mode, run `ipconfig /renew` on PC2, and step through the DHCP messages',
      'Run `ipconfig /release` on PC2, then `show ip dhcp binding` on R1 again',
    ],
    load: () => import('./dhcp-router.tracer.json?raw').then(text),
  },
];

export const DIFFICULTY_LABELS: Record<Difficulty, string> = {
  beginner: 'Beginner',
  intermediate: 'Intermediate',
};

export function deviceCount(lab: SampleLab): number {
  return Object.values(lab.devices).reduce((sum, count) => sum + count, 0);
}

/** The sample lab a lab name belongs to, if any. */
export function sampleNamed(name: string): SampleLab | undefined {
  return SAMPLE_LABS.find((lab) => lab.title === name);
}
