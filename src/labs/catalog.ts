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
    id: 'layer3-switch',
    title: 'Layer 3 switch',
    description:
      'No router this time. A multilayer switch carries Sales and Staff in two VLANs and, with `ip routing` on, routes between them on its own VLAN interfaces.',
    difficulty: 'intermediate',
    devices: { switch: 1, pc: 4 },
    tryThis: [
      'Ping PC3 (192.168.20.10, VLAN 20) from PC1 (VLAN 10)',
      'Run `tracert 192.168.20.10` on PC1: the one hop on the way is MLS1’s Vlan10',
      'Run `show ip route` on MLS1: both VLANs are directly connected',
      'Run `no ip routing` on MLS1, then ping PC3 again',
    ],
    load: () => import('./layer3-switch.tracer.json?raw').then(text),
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
  {
    id: 'ospf-three-routers',
    title: 'Three routers with OSPF',
    description:
      'Three routers in a triangle learn each other’s LANs with OSPF. Fast Gigabit links beat the slow serial one, until a link goes down and OSPF finds the way round.',
    difficulty: 'intermediate',
    devices: { router: 3, pc: 3 },
    tryThis: [
      'Run `show ip ospf neighbor` on R1: both neighbours are FULL',
      'Run `show ip route` on R1 and find the O routes, with their cost after 110/',
      'Ping PC3 (192.168.3.10) from PC1’s Command Prompt: the path crosses all three routers',
      'Run `show ip ospf interface brief` on R2 to see each link’s cost and DR state',
      'Shut down R2’s GigabitEthernet0/2, then run `show ip route` on R1 again: R3’s LAN is now over the serial link',
    ],
    load: () => import('./ospf-three-routers.tracer.json?raw').then(text),
  },
  {
    id: 'eigrp-feasible-successor',
    title: 'EIGRP with a feasible successor',
    description:
      'Three routers in a triangle run EIGRP. R1 reaches R3’s LAN through R2, and keeps the slow serial link to R3 as a feasible successor: when R2’s link fails, R1 switches at once, without asking anyone.',
    difficulty: 'intermediate',
    devices: { router: 3, pc: 3 },
    tryThis: [
      'Run `show ip eigrp neighbors` on R1: R2 and R3 are its neighbours',
      'Run `show ip route` on R1 and find the D routes, with their metric after 90/',
      'Run `show ip eigrp topology` on R1: R3’s LAN has two paths, the successor and a feasible successor',
      'Ping PC3 (192.168.3.10) from PC1’s Command Prompt',
      'Shut down R1’s GigabitEthernet0/1, then run `show ip route` on R1 again: R3’s LAN is over the serial link',
    ],
    load: () => import('./eigrp-feasible-successor.tracer.json?raw').then(text),
  },
  {
    id: 'dns-web-server',
    title: 'DNS and a web server',
    description:
      'Server1 runs DNS and HTTP. PC1 browses to www.lab.local by name: it asks DNS for the address, opens a TCP connection, and fetches the page over HTTP.',
    difficulty: 'beginner',
    devices: { switch: 1, pc: 1, server: 1 },
    tryThis: [
      'Open PC1’s Web Browser on its Desktop and go to `http://www.lab.local`',
      'Run `nslookup www.lab.local` in PC1’s Command Prompt',
      'Switch to Simulation mode, load the page again, and step through DNS, then TCP, then HTTP',
      'Edit index.html in Server1’s Services tab, then reload the page on PC1',
    ],
    load: () => import('./dns-web-server.tracer.json?raw').then(text),
  },
  {
    id: 'pat-acl',
    title: 'PAT and an access list',
    description:
      'Three PCs share one public address through PAT on R1, which tells their traffic apart by port. An access list on the LAN port keeps PC3 off the web, but lets its pings through.',
    difficulty: 'intermediate',
    devices: { router: 1, switch: 1, pc: 3, server: 1 },
    tryThis: [
      'Ping the server (203.0.113.10) from PC1’s Command Prompt, then from PC2’s',
      'Run `show ip nat translations` on R1: both PCs share 203.0.113.1, each on its own port',
      'Open PC1’s Web Browser and go to `http://203.0.113.10`, then run `show ip nat translations` again to find the tcp entry',
      'Browse to the same page from PC3: access list 110 denies it, though PC3 can still ping the server',
      'Run `show access-lists` on R1 to see how many packets each entry matched',
      'Switch to Simulation mode and browse from PC3 again to watch R1 drop the packet: ACL deny',
    ],
    load: () => import('./pat-acl.tracer.json?raw').then(text),
  },
  {
    id: 'ipv6-slaac',
    title: 'IPv6 with SLAAC',
    description:
      'Two LANs behind one router, on IPv6 alone. No PC has an address typed in: R1 advertises each LAN’s prefix, and every PC builds its own address from it and its MAC.',
    difficulty: 'intermediate',
    devices: { router: 1, switch: 2, pc: 4 },
    tryThis: [
      'Run `ipv6config` on PC3 to see the address it formed and its gateway, FE80::1',
      'Ping PC3’s IPv6 address from PC1’s Command Prompt',
      'Run `show ipv6 route` on R1: both prefixes are connected, with a local /128 for each address',
      'Run `show ipv6 neighbors` on R1 after the ping to see the PCs it resolved',
      'Switch to Simulation mode and ping again to step through Neighbor Discovery, then ICMPv6',
    ],
    load: () => import('./ipv6-slaac.tracer.json?raw').then(text),
  },
  {
    id: 'remote-management',
    title: 'Remote management: console and SSH',
    description:
      'Manage a router three ways: over the console cable, by SSH with a local user, and onward by Telnet to a switch. R1 refuses Telnet, since its vty lines take SSH only.',
    difficulty: 'intermediate',
    devices: { router: 1, switch: 1, pc: 1 },
    tryThis: [
      'Open PC1’s Terminal app and click OK: the console cable reaches R1. Log in with the console password `cisco`',
      'In that console, run `enable` with the secret `class`, then `show ip ssh`',
      'From PC1’s Command Prompt, run `ssh -l admin 192.168.1.1` and log in with `cisco123`',
      'Run `telnet 192.168.1.1` from PC1: R1 refuses, as its vty lines take SSH only',
      'Over SSH on R1, run `telnet 192.168.1.2` to reach SW1 (password `cisco`), then `show users`',
      'Switch to Simulation mode and log in again to see TCP to port 22, with the SSH data encrypted',
    ],
    load: () => import('./remote-management.tracer.json?raw').then(text),
    id: 'etherchannel',
    title: 'EtherChannel between switches',
    description:
      'Two switches joined by two cables that LACP bundles into one port-channel. Spanning tree treats the bundle as one link, so both cables carry traffic and either can fail.',
    difficulty: 'intermediate',
    devices: { switch: 2, pc: 2 },
    tryThis: [
      'Run `show etherchannel summary` on SW1: Po1(SU) with both ports (P)',
      'Run `show spanning-tree` on SW1: Po1 is one port, and nothing blocks',
      'Run `show cdp neighbors` on SW1 to see SW2 on both uplinks',
      'Ping PC2 (192.168.1.11) from PC1, delete one uplink cable, and ping again',
    ],
    load: () => import('./etherchannel.tracer.json?raw').then(text),
  },
  {
    id: 'port-security',
    title: 'Port security',
    description:
      'SW1’s Fa0/1 takes one device, learned sticky. A second device on the port is a violation, and the switch err-disables the port.',
    difficulty: 'intermediate',
    devices: { switch: 1, pc: 3 },
    tryThis: [
      'Ping PC2 (192.168.1.11) from PC1, then run `show port-security interface fa0/1` on SW1',
      'Run `show running-config` on SW1 to find the sticky address it learned',
      'Move PC1’s cable to the Intruder and ping PC2 from it: Fa0/1 goes down',
      'Move the cable back, then `shutdown` and `no shutdown` Fa0/1 to recover it',
    ],
    load: () => import('./port-security.tracer.json?raw').then(text),
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
