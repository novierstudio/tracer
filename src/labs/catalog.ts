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
    id: 'layer3-switch-ospf',
    title: 'Layer 3 switch with OSPF and DHCP',
    description:
      'A multilayer switch lends the Sales VLAN its addresses by DHCP and runs OSPF with a router over a routed port, so the PCs reach a LAN beyond the router.',
    difficulty: 'intermediate',
    devices: { switch: 1, router: 1, pc: 3 },
    tryThis: [
      'Run `show ip ospf neighbor` on MLS1: R1 is FULL',
      'Run `show ip route` on MLS1 and find R1’s LAN as an O route',
      'Run `ipconfig /all` on PC1: MLS1 lent its address and gateway',
      'Ping PC3 (192.168.20.10) from PC1’s Command Prompt',
      'Run `show ip dhcp binding` on MLS1 to see both leases',
    ],
    load: () => import('./layer3-switch-ospf.tracer.json?raw').then(text),
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
    id: 'ospf-multi-area',
    title: 'Multi-area OSPF with an ABR and a default route',
    description:
      'R2 joins area 1 to the backbone and sums area 1 up into one route. R3 borders the Internet: it brings in its ISP link and a default route as external routes, so PC1 reaches 8.8.8.8 across both areas.',
    difficulty: 'intermediate',
    devices: { router: 4, pc: 2 },
    tryThis: [
      'Run `show ip route` on R1: O IA routes come from area 0, and O*E2 is the default route R3 originates',
      'Ping 8.8.8.8 from PC1’s Command Prompt',
      'Run `show ip route` on R3: `area 1 range` on R2 folds area 1 into one O IA route, 10.1.0.0/16',
      'Run `show ip ospf database` on R2 to see both areas’ LSAs and the Type-5 externals',
      'Run `show ip ospf border-routers` on R1 to find the ABR and the ASBR',
    ],
    load: () => import('./ospf-multi-area.tracer.json?raw').then(text),
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
    id: 'server-services',
    title: 'Server services: TFTP backup, FTP, email, NTP and syslog',
    description:
      'Server1 runs the services a lab network leans on. R1 backs its config up over TFTP, sets its clock by NTP and logs to Server1, and two PCs move files over FTP and mail each other.',
    difficulty: 'beginner',
    devices: { router: 1, switch: 1, pc: 2, server: 1 },
    tryThis: [
      'On R1, run `copy running-config tftp:` to 192.168.1.20, then find R1-confg in Server1’s TFTP service',
      'Run `show ntp associations` and `show clock` on R1: the clock follows Server1 once NTP syncs',
      'Shut R1’s Gi0/1 and read the %LINK and %LINEPROTO messages in Server1’s SYSLOG service',
      'In PC1’s Command Prompt, run `ftp 192.168.1.20`, log in as cisco and `put sampleFile.txt`',
      'Send a mail from PC1’s Email app to user2@lab.local, then press Receive on PC2',
    ],
    load: () => import('./server-services.tracer.json?raw').then(text),
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
  },
  {
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
  {
    id: 'hub-collisions',
    title: 'Hub and collisions',
    description:
      'Three PCs on a hub. The hub repeats every frame to every port, and its ports share one segment, so two frames that meet there collide.',
    difficulty: 'beginner',
    devices: { hub: 1, pc: 3 },
    tryThis: [
      'Ping PC2 (192.168.1.11) from PC1, and watch the hub copy each frame to PC3 too',
      'Switch to Simulation mode',
      'Type `ping 192.168.1.12` on PC1, then on PC2, before stepping',
      'Step: both ARP requests reach Hub1 at once and collide, and both pings time out',
    ],
    load: () => import('./hub-collisions.tracer.json?raw').then(text),
  },
  {
    id: 'home-wireless',
    title: 'Home wireless network',
    description:
      'A home wireless router between laptops and an ISP. It takes its Internet address by DHCP, lends addresses on its LAN and wireless, and translates them to the Internet.',
    difficulty: 'beginner',
    devices: { router: 1, server: 1, wirelessRouter: 1, pc: 3 },
    tryThis: [
      'Open Laptop1’s PC Wireless app and join HomeNet with the key `tracer123`',
      'Run `ipconfig` on Laptop1: it leased an address from HomeRouter',
      'Ping Server1 (198.51.100.10) from Laptop1',
      'Change HomeRouter’s passphrase in its Config tab, and watch the laptops drop off',
    ],
    load: () => import('./home-wireless.tracer.json?raw').then(text),
  },
  {
    id: 'wlc-lightweight-aps',
    title: 'Wireless LAN controller',
    description:
      'Two lightweight APs take addresses by DHCP, find the controller WLC1 through option 43 and join it over CAPWAP. Once joined, each broadcasts the controller’s WLAN, and the laptops associate.',
    difficulty: 'intermediate',
    devices: { router: 1, switch: 1, wlc: 1, lightweightAp: 2, pc: 2 },
    tryThis: [
      'Open WLC1’s Config tab: both APs are in its AP list',
      'Ping R1 (192.168.10.1) from Laptop1',
      'Add a WLAN named Guest on WLC1, then join it from a laptop’s PC Wireless app',
      'Switch to Simulation mode, power LAP2 off and on, and watch its CAPWAP join',
    ],
    load: () => import('./wlc-lightweight-aps.tracer.json?raw').then(text),
  },
  {
    id: 'smart-home',
    title: 'Smart home',
    description:
      'A Home Gateway serves a lamp, a door and a motion detector, which register with its IoT server. A laptop on the gateway’s wireless signs in to its web page and controls them.',
    difficulty: 'beginner',
    devices: { wirelessRouter: 1, pc: 4 },
    tryThis: [
      'Browse from the laptop to `192.168.25.1` and sign in as `admin` with password `admin`',
      'Turn the lamp on from the page, and watch its Config tab follow',
      'Set the motion detector to Yes in its Config tab, then refresh the page',
      'Lock the door from the page',
    ],
    load: () => import('./smart-home.tracer.json?raw').then(text),
  },
  {
    id: 'vtp-server-clients',
    title: 'VTP server and clients',
    description:
      'SW1 is the VTP server for domain CCNA and holds VLANs 10 and 20. SW2 and SW3 are clients: they learn both VLANs over their trunks, so their access ports come up.',
    difficulty: 'intermediate',
    devices: { switch: 3, pc: 4 },
    tryThis: [
      'Run `show vtp status` on SW1, then on SW2: same domain, same revision',
      'Run `show vlan brief` on SW3 to see the VLANs it learned',
      'Ping PC2 (192.168.10.12) from PC1, across SW1',
      'Type `vlan 30` in global config on SW2: a client refuses it',
      'Add `vlan 30` with `name Guests` on SW1 and watch the revision climb on SW2 and SW3',
    ],
    load: () => import('./vtp-server-clients.tracer.json?raw').then(text),
  },
  {
    id: 'hsrp-gateway',
    title: 'HSRP gateway redundancy',
    description:
      'R1 and R2 share the virtual gateway 192.168.1.1 with HSRP. R1 is active, R2 stands by, and OSPF carries the LAN to R3 both ways, so PC1 keeps reaching the server when R1 fails.',
    difficulty: 'intermediate',
    devices: { router: 3, switch: 1, pc: 2 },
    tryThis: [
      'Run `show standby brief` on R1 and R2: R1 is active, R2 standby',
      'Ping the server (192.168.2.10) from PC1, then run `arp -a`: the gateway is 0000.0c07.ac01',
      'Delete the cable between R1 and SW1, wait ten seconds, and ping again: R2 took over',
      'Put it back: R1 preempts and is active again',
      'Shut R1’s Gig0/1: tracking drops its priority to 90 and R2 takes over',
    ],
    load: () => import('./hsrp-gateway.tracer.json?raw').then(text),
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
