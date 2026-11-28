/**
 * Builds each sample lab the way a student would: real catalog devices, IOS config typed line by
 * line, cables and notes. The committed `.tracer.json` files were written from it; the app never
 * imports it.
 */
import { applyLines, toConfigUpdate, type IosDevice } from '@/cli';
import type { DeviceModelId } from '@/devices/catalog';
import { createDevice } from '@/devices/create';
import {
  addAnnotation,
  autoCable,
  cableEnd,
  addDevice,
  addLink,
  AnnotationId,
  DeviceId,
  emptyTopology,
  Hostname,
  DnsRecord,
  Ipv4Address,
  Ipv4Cidr,
  LinkId,
  NOTE_WIDTH,
  PortId,
  updateConfig,
  type Device,
  type Link,
  type ServerServices,
  type Topology,
} from '@/model';
import { SAMPLE_LABS } from './catalog';

const CREATED = new Date('2026-11-25T00:00:00.000Z');

const unwrap = <T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
};

const cidr = (text: string) => {
  const [address, prefixLength] = text.split('/');
  return Ipv4Cidr.parse({ address, prefixLength: Number(prefixLength) });
};

type Cable = { cable: 'console' } | { cable: 'serial'; dce: 'a' | 'b' };

function labBuilder(id: string) {
  const sample = SAMPLE_LABS.find((lab) => lab.id === id)!;
  let topology = emptyTopology({ name: sample.title, now: CREATED });
  // Ids differ between labs, because consoles stay open for as long as their device id exists.
  const tag = id
    .split('-')
    .map((word) => word[0])
    .join('');
  const deviceId = (name: string) => DeviceId.parse(`dev_${tag}${name}`);

  const add = (
    name: string,
    model: DeviceModelId,
    x: number,
    y: number,
    edit: (device: Device) => void = () => {},
  ) => {
    const index = Object.keys(topology.devices).length + 1;
    const device = createDevice(model, {
      id: deviceId(name),
      position: { x, y },
      existingNames: [],
      macSeed: index * 7919,
    });
    device.config.hostname = Hostname.parse(name);
    edit(device);
    topology = unwrap(addDevice(topology, device));
  };

  return {
    /** A router or switch, configured by typing `lines` in global config mode. */
    ios(name: string, model: DeviceModelId, x: number, y: number, lines: readonly string[]) {
      add(name, model, x, y);
      const device = topology.devices[deviceId(name)] as IosDevice;
      const { config, errors } = applyLines(device, lines);
      if (errors.length > 0 || config.unknownLines.length > 0) {
        throw new Error(`${name}: ${JSON.stringify({ errors, unknown: config.unknownLines })}`);
      }
      topology = unwrap(updateConfig(topology, toConfigUpdate({ ...device, config } as IosDevice)));
    },

    pc(name: string, x: number, y: number, address: string, gateway?: string, dns?: string) {
      add(name, 'pc', x, y, (device) => {
        if (device.kind !== 'pc') throw new Error(`${name} is not a PC`);
        device.config.ipv4 = {
          mode: 'static',
          address: cidr(address),
          gateway: gateway === undefined ? undefined : Ipv4Address.parse(gateway),
          ...(dns !== undefined && { dns: Ipv4Address.parse(dns) }),
        };
      });
    },

    /** A server with a static address and the services its Services tab would set. */
    server(
      name: string,
      x: number,
      y: number,
      address: string,
      services: ServerServices,
      gateway?: string,
    ) {
      add(name, 'server', x, y, (device) => {
        if (device.kind !== 'server') throw new Error(`${name} is not a server`);
        device.config.ipv4 = {
          mode: 'static',
          address: cidr(address),
          ...(gateway !== undefined && { gateway: Ipv4Address.parse(gateway) }),
        };
        device.config.services = services;
      });
    },

    /** A PC with IPv6 on automatic and no IPv4 address: it forms its address by SLAAC. */
    slaacPc(name: string, x: number, y: number) {
      add(name, 'pc', x, y, (device) => {
        if (device.kind !== 'pc') throw new Error(`${name} is not a PC`);
        device.config.ipv4 = { mode: 'static' };
        device.config.ipv6 = { mode: 'auto' };
      });
    },

    /** Any catalog device, as `edit` leaves it after the factory settings. */
    device(
      name: string,
      model: DeviceModelId,
      x: number,
      y: number,
      edit?: (device: Device) => void,
    ) {
      add(name, model, x, y, edit);
    },

    /**
     * A laptop with a wireless card in place of its Ethernet one, set to DHCP. `ssid` and
     * `passphrase`, when given, are the network its PC Wireless app has joined.
     */
    wirelessLaptop(
      name: string,
      x: number,
      y: number,
      join?: { ssid: string; passphrase: string },
    ) {
      add(name, 'laptop', x, y, (device) => {
        if (device.kind !== 'pc') throw new Error(`${name} is not a PC`);
        const [card] = device.ports;
        if (!card || card.kind === 'serial') throw new Error(`${name} has no Ethernet card`);
        device.ports = [{ kind: 'wireless', id: PortId.parse('Wireless0'), mac: card.mac }];
        device.config.ipv4 = { mode: 'dhcp' };
        if (join) {
          const security = { mode: 'wpa2-psk' as const, passphrase: join.passphrase };
          device.config.wireless = { ssid: join.ssid, security };
        }
      });
    },

    /** A PC that asks a DHCP server for its address. */
    dhcpPc(name: string, x: number, y: number) {
      add(name, 'pc', x, y, (device) => {
        if (device.kind !== 'pc') throw new Error(`${name} is not a PC`);
        device.config.ipv4 = { mode: 'dhcp' };
      });
    },

    /**
     * A cable from port to port: by default the network cable Packet Tracer's automatic cable
     * picks. `suffix` tells apart two cables between the same devices, as an EtherChannel has.
     */
    cable(a: [string, string], b: [string, string], kind?: Cable, suffix = '') {
      const ends = {
        a: { device: deviceId(a[0]), port: PortId.parse(a[1]) },
        b: { device: deviceId(b[0]), port: PortId.parse(b[1]) },
      };
      const auto = autoCable(cableEnd(topology, ends.a)!, cableEnd(topology, ends.b)!);
      const link = {
        id: LinkId.parse(`lnk_${tag}${a[0]}${b[0]}${suffix}`),
        ...ends,
        ...(kind ?? { cable: auto }),
      } as Link;
      topology = unwrap(addLink(topology, link));
    },

    note(name: string, x: number, y: number, text: string) {
      const id = AnnotationId.parse(`ann_${tag}${name}`);
      const note = { id, kind: 'note' as const, position: { x, y }, text };
      topology = unwrap(addAnnotation(topology, { ...note, width: NOTE_WIDTH, color: 'amber' }));
    },

    get topology(): Topology {
      return topology;
    },
  };
}

// Device positions are tile centres. 24 + 16n puts a tile's edges on the 16-unit grid.

function twoPcsSwitch() {
  const lab = labBuilder('two-pcs-switch');
  lab.ios('SW1', 'switch-24', 232, 40, []);
  lab.pc('PC1', 40, 232, '192.168.1.10/24');
  lab.pc('PC2', 424, 232, '192.168.1.11/24');
  lab.cable(['PC1', 'FastEthernet0'], ['SW1', 'FastEthernet0/1']);
  lab.cable(['PC2', 'FastEthernet0'], ['SW1', 'FastEthernet0/2']);
  lab.note(
    'subnet',
    544,
    -16,
    'Both PCs are in 192.168.1.0/24. The switch forwards frames by MAC address, so no router is needed.',
  );
  return lab.topology;
}

function twoLansRouter() {
  const lab = labBuilder('two-lans-router');
  lab.ios('R1', 'router-2g2s', 488, 40, [
    'interface GigabitEthernet0/0',
    ' ip address 192.168.1.1 255.255.255.0',
    ' no shutdown',
    'interface GigabitEthernet0/1',
    ' ip address 192.168.2.1 255.255.255.0',
    ' no shutdown',
  ]);
  lab.ios('SW1', 'switch-24', 232, 232, []);
  lab.ios('SW2', 'switch-24', 744, 232, []);
  lab.pc('PC1', 72, 424, '192.168.1.10/24', '192.168.1.1');
  lab.pc('PC2', 392, 424, '192.168.1.11/24', '192.168.1.1');
  lab.pc('PC3', 584, 424, '192.168.2.10/24', '192.168.2.1');
  lab.pc('PC4', 904, 424, '192.168.2.11/24', '192.168.2.1');
  lab.cable(['PC1', 'FastEthernet0'], ['SW1', 'FastEthernet0/1']);
  lab.cable(['PC2', 'FastEthernet0'], ['SW1', 'FastEthernet0/2']);
  lab.cable(['SW1', 'GigabitEthernet0/1'], ['R1', 'GigabitEthernet0/0']);
  lab.cable(['R1', 'GigabitEthernet0/1'], ['SW2', 'GigabitEthernet0/1']);
  lab.cable(['PC3', 'FastEthernet0'], ['SW2', 'FastEthernet0/1']);
  lab.cable(['PC4', 'FastEthernet0'], ['SW2', 'FastEthernet0/2']);
  lab.note('lanA', 136, 512, 'LAN A: 192.168.1.0/24. Default gateway 192.168.1.1, R1’s Gi0/0.');
  lab.note('lanB', 648, 512, 'LAN B: 192.168.2.0/24. Default gateway 192.168.2.1, R1’s Gi0/1.');
  return lab.topology;
}

function staticRoutesSerial() {
  const lab = labBuilder('static-routes-serial');
  lab.ios('R1', 'router-2g2s', 232, 232, [
    'interface GigabitEthernet0/0',
    ' ip address 192.168.1.1 255.255.255.0',
    ' no shutdown',
    'interface Serial0/0/0',
    ' ip address 10.0.0.1 255.255.255.252',
    ' clock rate 64000',
    ' no shutdown',
    'ip route 192.168.2.0 255.255.255.0 10.0.0.2',
  ]);
  lab.ios('R2', 'router-2g2s', 616, 232, [
    'interface GigabitEthernet0/0',
    ' ip address 192.168.2.1 255.255.255.0',
    ' no shutdown',
    'interface Serial0/0/0',
    ' ip address 10.0.0.2 255.255.255.252',
    ' no shutdown',
    'ip route 192.168.1.0 255.255.255.0 10.0.0.1',
  ]);
  lab.pc('PC1', 40, 232, '192.168.1.10/24', '192.168.1.1');
  lab.pc('PC2', 808, 232, '192.168.2.10/24', '192.168.2.1');
  lab.cable(['PC1', 'FastEthernet0'], ['R1', 'GigabitEthernet0/0']);
  lab.cable(['R1', 'Serial0/0/0'], ['R2', 'Serial0/0/0'], { cable: 'serial', dce: 'a' });
  lab.cable(['R2', 'GigabitEthernet0/0'], ['PC2', 'FastEthernet0']);
  lab.note(
    'serial',
    328,
    32,
    'The serial link is 10.0.0.0/30. R1 holds the DCE end of the cable, so it sets the clock rate.',
  );
  lab.note(
    'routes',
    328,
    336,
    'Each router knows only its own networks. A static route on each points at the far LAN.',
  );
  return lab.topology;
}

function routerOnAStick() {
  const lab = labBuilder('router-on-a-stick');
  lab.ios('R1', 'router-2g2s', 424, 40, [
    'interface GigabitEthernet0/0',
    ' no shutdown',
    'interface GigabitEthernet0/0.10',
    ' description Sales',
    ' encapsulation dot1Q 10',
    ' ip address 192.168.10.1 255.255.255.0',
    'interface GigabitEthernet0/0.20',
    ' description Staff',
    ' encapsulation dot1Q 20',
    ' ip address 192.168.20.1 255.255.255.0',
  ]);
  lab.ios('SW1', 'switch-24', 424, 232, [
    'vlan 10',
    ' name Sales',
    'vlan 20',
    ' name Staff',
    'interface range FastEthernet0/1 - 2',
    ' switchport mode access',
    ' switchport access vlan 10',
    'interface range FastEthernet0/3 - 4',
    ' switchport mode access',
    ' switchport access vlan 20',
    'interface GigabitEthernet0/1',
    ' switchport mode trunk',
  ]);
  // Sales on the left of the switch, Staff on the right.
  lab.pc('PC1', 136, 184, '192.168.10.10/24', '192.168.10.1');
  lab.pc('PC2', 136, 376, '192.168.10.11/24', '192.168.10.1');
  lab.pc('PC3', 712, 184, '192.168.20.10/24', '192.168.20.1');
  lab.pc('PC4', 712, 376, '192.168.20.11/24', '192.168.20.1');
  lab.cable(['PC1', 'FastEthernet0'], ['SW1', 'FastEthernet0/1']);
  lab.cable(['PC2', 'FastEthernet0'], ['SW1', 'FastEthernet0/2']);
  lab.cable(['PC3', 'FastEthernet0'], ['SW1', 'FastEthernet0/3']);
  lab.cable(['PC4', 'FastEthernet0'], ['SW1', 'FastEthernet0/4']);
  lab.cable(['SW1', 'GigabitEthernet0/1'], ['R1', 'GigabitEthernet0/0']);
  lab.note('sales', 48, 464, 'VLAN 10, Sales: 192.168.10.0/24, gateway 192.168.10.1.');
  lab.note('staff', 624, 464, 'VLAN 20, Staff: 192.168.20.0/24, gateway 192.168.20.1.');
  lab.note(
    'trunk',
    528,
    0,
    'One trunk carries both VLANs to R1, which routes between them on Gi0/0.10 and Gi0/0.20.',
  );
  return lab.topology;
}

function layer3Switch() {
  const lab = labBuilder('layer3-switch');
  lab.ios('MLS1', 'switch-l3-24', 424, 280, [
    'ip routing',
    'vlan 10',
    ' name Sales',
    'vlan 20',
    ' name Staff',
    'interface range FastEthernet0/1 - 2',
    ' switchport mode access',
    ' switchport access vlan 10',
    'interface range FastEthernet0/3 - 4',
    ' switchport mode access',
    ' switchport access vlan 20',
    'interface Vlan10',
    ' description Sales',
    ' ip address 192.168.10.1 255.255.255.0',
    'interface Vlan20',
    ' description Staff',
    ' ip address 192.168.20.1 255.255.255.0',
  ]);
  // Sales on the left of the switch, Staff on the right.
  lab.pc('PC1', 136, 184, '192.168.10.10/24', '192.168.10.1');
  lab.pc('PC2', 136, 376, '192.168.10.11/24', '192.168.10.1');
  lab.pc('PC3', 712, 184, '192.168.20.10/24', '192.168.20.1');
  lab.pc('PC4', 712, 376, '192.168.20.11/24', '192.168.20.1');
  lab.cable(['PC1', 'FastEthernet0'], ['MLS1', 'FastEthernet0/1']);
  lab.cable(['PC2', 'FastEthernet0'], ['MLS1', 'FastEthernet0/2']);
  lab.cable(['PC3', 'FastEthernet0'], ['MLS1', 'FastEthernet0/3']);
  lab.cable(['PC4', 'FastEthernet0'], ['MLS1', 'FastEthernet0/4']);
  lab.note('sales', 48, 464, 'VLAN 10, Sales: 192.168.10.0/24, gateway Vlan10 at 192.168.10.1.');
  lab.note('staff', 624, 464, 'VLAN 20, Staff: 192.168.20.0/24, gateway Vlan20 at 192.168.20.1.');
  lab.note(
    'svis',
    336,
    48,
    'No router: with ip routing on, MLS1 routes between its two VLAN interfaces itself.',
  );
  return lab.topology;
}

function stpTriangle() {
  const lab = labBuilder('stp-triangle');
  lab.ios('SW1', 'switch-24', 424, 40, ['spanning-tree vlan 1 priority 4096']);
  lab.ios('SW2', 'switch-24', 232, 232, []);
  lab.ios('SW3', 'switch-24', 616, 232, []);
  lab.pc('PC1', 232, 424, '192.168.1.10/24');
  lab.pc('PC2', 616, 424, '192.168.1.11/24');
  lab.cable(['SW1', 'GigabitEthernet0/1'], ['SW2', 'GigabitEthernet0/1']);
  lab.cable(['SW1', 'GigabitEthernet0/2'], ['SW3', 'GigabitEthernet0/1']);
  lab.cable(['SW2', 'GigabitEthernet0/2'], ['SW3', 'GigabitEthernet0/2']);
  lab.cable(['PC1', 'FastEthernet0'], ['SW2', 'FastEthernet0/1']);
  lab.cable(['PC2', 'FastEthernet0'], ['SW3', 'FastEthernet0/1']);
  lab.note(
    'root',
    528,
    -16,
    'SW1 has bridge priority 4096, lower than the default 32768, so it is the root bridge.',
  );
  lab.note(
    'loop',
    328,
    288,
    'A loop would carry broadcasts forever. Spanning tree blocks one port on this link to break it.',
  );
  return lab.topology;
}

function dhcpRouter() {
  const lab = labBuilder('dhcp-router');
  lab.ios('R1', 'router-2g2s', 232, 40, [
    'ip dhcp excluded-address 192.168.1.1 192.168.1.10',
    'ip dhcp pool LAN',
    ' network 192.168.1.0 255.255.255.0',
    ' default-router 192.168.1.1',
    ' dns-server 8.8.8.8',
    'interface GigabitEthernet0/0',
    ' ip address 192.168.1.1 255.255.255.0',
    ' no shutdown',
  ]);
  lab.ios('SW1', 'switch-24', 232, 232, []);
  lab.dhcpPc('PC1', 40, 424);
  lab.dhcpPc('PC2', 424, 424);
  lab.cable(['SW1', 'GigabitEthernet0/1'], ['R1', 'GigabitEthernet0/0']);
  lab.cable(['PC1', 'FastEthernet0'], ['SW1', 'FastEthernet0/1']);
  lab.cable(['PC2', 'FastEthernet0'], ['SW1', 'FastEthernet0/2']);
  lab.note(
    'pool',
    360,
    -16,
    'R1’s pool LAN lends 192.168.1.0/24, with R1 as the gateway. It never lends .1 to .10, which are kept for routers and servers.',
  );
  lab.note(
    'dora',
    136,
    512,
    'Both PCs are set to DHCP. Each asks with a Discover when its cable comes up: Discover, Offer, Request, Ack.',
  );
  return lab.topology;
}

/**
 * An OSPF router's lines: each interface with its address and an optional clock rate, then
 * process 1 with a router ID, the LAN port passive, and a `network` line per link.
 */
function ospfRouter(
  id: number,
  interfaces: readonly [name: string, address: string, clock?: string][],
  networks: readonly string[],
) {
  return [
    ...interfaces.flatMap(([name, address, clock]) => [
      `interface ${name}`,
      ` ip address ${address}`,
      ...(clock ? [` clock rate ${clock}`] : []),
      ' no shutdown',
    ]),
    'router ospf 1',
    ` router-id ${id}.${id}.${id}.${id}`,
    ' passive-interface GigabitEthernet0/0',
    ...networks.map((network) => ` network ${network} area 0`),
  ];
}

function ospfThreeRouters() {
  const lab = labBuilder('ospf-three-routers');
  lab.ios(
    'R1',
    'router-2g2s',
    232,
    424,
    ospfRouter(
      1,
      [
        ['GigabitEthernet0/0', '192.168.1.1 255.255.255.0'],
        ['GigabitEthernet0/1', '10.0.12.1 255.255.255.252'],
        ['Serial0/0/0', '10.0.13.1 255.255.255.252', '64000'],
      ],
      ['192.168.1.0 0.0.0.255', '10.0.12.0 0.0.0.3', '10.0.13.0 0.0.0.3'],
    ),
  );
  lab.ios(
    'R2',
    'router-4g',
    424,
    232,
    ospfRouter(
      2,
      [
        ['GigabitEthernet0/0', '192.168.2.1 255.255.255.0'],
        ['GigabitEthernet0/1', '10.0.12.2 255.255.255.252'],
        ['GigabitEthernet0/2', '10.0.23.1 255.255.255.252'],
      ],
      ['192.168.2.0 0.0.0.255', '10.0.12.0 0.0.0.3', '10.0.23.0 0.0.0.3'],
    ),
  );
  lab.ios(
    'R3',
    'router-2g2s',
    616,
    424,
    ospfRouter(
      3,
      [
        ['GigabitEthernet0/0', '192.168.3.1 255.255.255.0'],
        ['GigabitEthernet0/1', '10.0.23.2 255.255.255.252'],
        ['Serial0/0/0', '10.0.13.2 255.255.255.252'],
      ],
      ['192.168.3.0 0.0.0.255', '10.0.23.0 0.0.0.3', '10.0.13.0 0.0.0.3'],
    ),
  );
  lab.pc('PC1', 40, 424, '192.168.1.10/24', '192.168.1.1');
  lab.pc('PC2', 424, 40, '192.168.2.10/24', '192.168.2.1');
  lab.pc('PC3', 808, 424, '192.168.3.10/24', '192.168.3.1');
  lab.cable(['R1', 'GigabitEthernet0/1'], ['R2', 'GigabitEthernet0/1']);
  lab.cable(['R2', 'GigabitEthernet0/2'], ['R3', 'GigabitEthernet0/1']);
  lab.cable(['R1', 'Serial0/0/0'], ['R3', 'Serial0/0/0'], { cable: 'serial', dce: 'a' });
  lab.cable(['PC1', 'FastEthernet0'], ['R1', 'GigabitEthernet0/0']);
  lab.cable(['PC2', 'FastEthernet0'], ['R2', 'GigabitEthernet0/0']);
  lab.cable(['PC3', 'FastEthernet0'], ['R3', 'GigabitEthernet0/0']);
  lab.note(
    'area',
    600,
    40,
    'Every router runs OSPF process 1 in area 0, with router IDs 1.1.1.1, 2.2.2.2 and 3.3.3.3. The LAN ports are passive: no hellos go to the PCs.',
  );
  lab.note(
    'cost',
    328,
    528,
    'Each Gigabit link costs 1 and the serial link 64, so R1 reaches R3’s LAN through R2 at cost 3 rather than straight across at 65.',
  );
  return lab.topology;
}

/**
 * An EIGRP router's lines: each interface with its address and an optional clock rate, then AS
 * 10 with a router ID, the LAN port passive, and a classful `network` line per network.
 */
function eigrpRouter(
  id: number,
  interfaces: readonly [name: string, address: string, clock?: string][],
) {
  return [
    ...interfaces.flatMap(([name, address, clock]) => [
      `interface ${name}`,
      ` ip address ${address}`,
      ...(clock ? [` clock rate ${clock}`] : []),
      ' no shutdown',
    ]),
    'router eigrp 10',
    ` eigrp router-id ${id}.${id}.${id}.${id}`,
    ' passive-interface GigabitEthernet0/0',
    ` network 192.168.${id}.0`,
    ' network 10.0.0.0',
  ];
}

function eigrpFeasibleSuccessor() {
  const lab = labBuilder('eigrp-feasible-successor');
  lab.ios(
    'R1',
    'router-2g2s',
    232,
    424,
    eigrpRouter(1, [
      ['GigabitEthernet0/0', '192.168.1.1 255.255.255.0'],
      ['GigabitEthernet0/1', '10.0.12.1 255.255.255.252'],
      ['Serial0/0/0', '10.0.13.1 255.255.255.252', '64000'],
    ]),
  );
  lab.ios(
    'R2',
    'router-4g',
    424,
    232,
    eigrpRouter(2, [
      ['GigabitEthernet0/0', '192.168.2.1 255.255.255.0'],
      ['GigabitEthernet0/1', '10.0.12.2 255.255.255.252'],
      ['GigabitEthernet0/2', '10.0.23.1 255.255.255.252'],
    ]),
  );
  lab.ios(
    'R3',
    'router-2g2s',
    616,
    424,
    eigrpRouter(3, [
      ['GigabitEthernet0/0', '192.168.3.1 255.255.255.0'],
      ['GigabitEthernet0/1', '10.0.23.2 255.255.255.252'],
      ['Serial0/0/0', '10.0.13.2 255.255.255.252'],
    ]),
  );
  lab.pc('PC1', 40, 424, '192.168.1.10/24', '192.168.1.1');
  lab.pc('PC2', 424, 40, '192.168.2.10/24', '192.168.2.1');
  lab.pc('PC3', 808, 424, '192.168.3.10/24', '192.168.3.1');
  lab.cable(['R1', 'GigabitEthernet0/1'], ['R2', 'GigabitEthernet0/1']);
  lab.cable(['R2', 'GigabitEthernet0/2'], ['R3', 'GigabitEthernet0/1']);
  lab.cable(['R1', 'Serial0/0/0'], ['R3', 'Serial0/0/0'], { cable: 'serial', dce: 'a' });
  lab.cable(['PC1', 'FastEthernet0'], ['R1', 'GigabitEthernet0/0']);
  lab.cable(['PC2', 'FastEthernet0'], ['R2', 'GigabitEthernet0/0']);
  lab.cable(['PC3', 'FastEthernet0'], ['R3', 'GigabitEthernet0/0']);
  lab.note(
    'as',
    600,
    40,
    'Every router runs EIGRP AS 10, with router IDs 1.1.1.1, 2.2.2.2 and 3.3.3.3. The LAN ports are passive: no hellos go to the PCs.',
  );
  lab.note(
    'fs',
    280,
    528,
    'R1 reaches R3’s LAN through R2 at 3328. R3 reports its own LAN at 2816, below that feasible distance, so it cannot loop back through R1: the serial path is a feasible successor, ready the moment R2’s link fails.',
  );
  return lab.topology;
}

const LAB_PAGE = `<!doctype html>
<html>
  <head>
    <title>Lab Web</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 2rem; line-height: 1.5; }
      h1 { color: #2563eb; }
    </style>
  </head>
  <body>
    <h1>Welcome to www.lab.local</h1>
    <p>Server1 sent this page over HTTP. Before it could ask, PC1 looked up the name with DNS.</p>
  </body>
</html>
`;

function dnsWebServer() {
  const lab = labBuilder('dns-web-server');
  lab.ios('SW1', 'switch-24', 232, 40, []);
  lab.pc('PC1', 40, 232, '192.168.1.10/24', undefined, '192.168.1.20');
  lab.server('Server1', 424, 232, '192.168.1.20/24', {
    dns: {
      enabled: true,
      records: [DnsRecord.parse({ name: 'www.lab.local', address: '192.168.1.20' })],
    },
    http: { enabled: true, indexHtml: LAB_PAGE },
  });
  lab.cable(['PC1', 'FastEthernet0'], ['SW1', 'FastEthernet0/1']);
  lab.cable(['Server1', 'GigabitEthernet0'], ['SW1', 'GigabitEthernet0/1']);
  lab.note(
    'dns',
    544,
    -16,
    'Server1 runs DNS, with one A record: www.lab.local is 192.168.1.20. PC1 uses it as its DNS server.',
  );
  lab.note(
    'http',
    544,
    120,
    'Server1 also runs HTTP. Browsing to http://www.lab.local is a DNS lookup, then a TCP handshake, then an HTTP GET.',
  );
  return lab.topology;
}

const PAT_PAGE = `<!doctype html>
<html>
  <head><title>Outside</title></head>
  <body>
    <h1>You reached 203.0.113.10</h1>
    <p>This server sees every PC as 203.0.113.1: R1's PAT tells them apart by port.</p>
  </body>
</html>
`;

function patAcl() {
  const lab = labBuilder('pat-acl');
  lab.ios('R1', 'router-2g2s', 424, 40, [
    'interface GigabitEthernet0/0',
    ' ip address 192.168.1.1 255.255.255.0',
    ' ip access-group 110 in',
    ' ip nat inside',
    ' no shutdown',
    'interface GigabitEthernet0/1',
    ' ip address 203.0.113.1 255.255.255.0',
    ' ip nat outside',
    ' no shutdown',
    'access-list 1 permit 192.168.1.0 0.0.0.255',
    'access-list 110 remark PC3 may not browse the web',
    'access-list 110 deny tcp host 192.168.1.12 any eq www',
    'access-list 110 permit ip any any',
    'ip nat inside source list 1 interface GigabitEthernet0/1 overload',
  ]);
  lab.ios('SW1', 'switch-24', 232, 232, []);
  lab.pc('PC1', 40, 424, '192.168.1.10/24', '192.168.1.1');
  lab.pc('PC2', 232, 424, '192.168.1.11/24', '192.168.1.1');
  lab.pc('PC3', 424, 424, '192.168.1.12/24', '192.168.1.1');
  lab.server('Server', 808, 40, '203.0.113.10/24', {
    dns: { enabled: false, records: [] },
    http: { enabled: true, indexHtml: PAT_PAGE },
  });
  lab.cable(['PC1', 'FastEthernet0'], ['SW1', 'FastEthernet0/1']);
  lab.cable(['PC2', 'FastEthernet0'], ['SW1', 'FastEthernet0/2']);
  lab.cable(['PC3', 'FastEthernet0'], ['SW1', 'FastEthernet0/3']);
  lab.cable(['SW1', 'GigabitEthernet0/1'], ['R1', 'GigabitEthernet0/0']);
  lab.cable(['R1', 'GigabitEthernet0/1'], ['Server', 'GigabitEthernet0']);
  lab.note(
    'pat',
    520,
    168,
    'R1 translates the inside LAN, 192.168.1.0/24, to its own outside address 203.0.113.1. PAT tells the PCs apart by port.',
  );
  lab.note(
    'server',
    760,
    168,
    'The server has no default gateway, so it can only answer 203.0.113.0/24: the PCs reach it through NAT or not at all.',
  );
  lab.note(
    'acl',
    520,
    392,
    'Access list 110, inbound on Gi0/0, denies web traffic (TCP port 80) from PC3 and permits everything else, ping included.',
  );
  return lab.topology;
}

function ipv6Slaac() {
  const lab = labBuilder('ipv6-slaac');
  lab.ios('R1', 'router-2g2s', 488, 40, [
    'ipv6 unicast-routing',
    'interface GigabitEthernet0/0',
    ' ipv6 address FE80::1 link-local',
    ' ipv6 address 2001:DB8:1::1/64',
    ' no shutdown',
    'interface GigabitEthernet0/1',
    ' ipv6 address FE80::1 link-local',
    ' ipv6 address 2001:DB8:2::1/64',
    ' no shutdown',
  ]);
  lab.ios('SW1', 'switch-24', 232, 232, []);
  lab.ios('SW2', 'switch-24', 744, 232, []);
  lab.slaacPc('PC1', 72, 424);
  lab.slaacPc('PC2', 392, 424);
  lab.slaacPc('PC3', 584, 424);
  lab.slaacPc('PC4', 904, 424);
  lab.cable(['PC1', 'FastEthernet0'], ['SW1', 'FastEthernet0/1']);
  lab.cable(['PC2', 'FastEthernet0'], ['SW1', 'FastEthernet0/2']);
  lab.cable(['SW1', 'GigabitEthernet0/1'], ['R1', 'GigabitEthernet0/0']);
  lab.cable(['R1', 'GigabitEthernet0/1'], ['SW2', 'GigabitEthernet0/1']);
  lab.cable(['PC3', 'FastEthernet0'], ['SW2', 'FastEthernet0/1']);
  lab.cable(['PC4', 'FastEthernet0'], ['SW2', 'FastEthernet0/2']);
  lab.note(
    'routing',
    616,
    -16,
    'R1 has ipv6 unicast-routing, so it advertises each LAN’s /64 prefix, with FE80::1 as the router.',
  );
  lab.note(
    'lanA',
    136,
    512,
    'LAN A: 2001:DB8:1::/64. The PCs are set to Automatic: each forms its address from the prefix and its MAC (EUI-64).',
  );
  lab.note('lanB', 648, 512, 'LAN B: 2001:DB8:2::/64. Default gateway FE80::1, R1’s Gi0/1.');
  return lab.topology;
}

function remoteManagement() {
  const lab = labBuilder('remote-management');
  lab.ios('R1', 'router-2g2s', 424, 40, [
    'enable secret class',
    'ip domain-name lab.local',
    'username admin privilege 15 secret cisco123',
    'crypto key generate rsa general-keys modulus 1024',
    'ip ssh version 2',
    'interface GigabitEthernet0/0',
    ' ip address 192.168.1.1 255.255.255.0',
    ' no shutdown',
    'banner motd #Authorized access only#',
    'line con 0',
    ' password cisco',
    ' login',
    'line vty 0 15',
    ' login local',
    ' transport input ssh',
  ]);
  lab.ios('SW1', 'switch-24', 424, 232, [
    'enable secret class',
    'interface Vlan1',
    ' ip address 192.168.1.2 255.255.255.0',
    ' no shutdown',
    'ip default-gateway 192.168.1.1',
    'line vty 0 15',
    ' password cisco',
    ' login',
    ' transport input telnet',
  ]);
  lab.pc('PC1', 136, 232, '192.168.1.10/24', '192.168.1.1');
  lab.cable(['PC1', 'FastEthernet0'], ['SW1', 'FastEthernet0/1']);
  lab.cable(['SW1', 'GigabitEthernet0/1'], ['R1', 'GigabitEthernet0/0']);
  lab.cable(['PC1', 'RS232'], ['R1', 'Console'], { cable: 'console' });
  lab.note(
    'console',
    -64,
    16,
    'The dotted cable is a console cable, from PC1’s RS232 port to R1’s Console port. PC1’s Terminal app talks to R1 over it, with no IP address needed.',
  );
  lab.note(
    'ssh',
    552,
    -16,
    'R1 runs SSH version 2 with a 1024-bit RSA key. Its vty lines take SSH only and check the local user admin.',
  );
  lab.note(
    'telnet',
    552,
    280,
    'SW1 is managed at 192.168.1.2 on Vlan1. Its vty lines take Telnet with the password cisco.',
  );
  return lab.topology;
}

function etherchannelLab() {
  const lab = labBuilder('etherchannel');
  const bundle = (mode: string) => [
    'interface range GigabitEthernet0/1 - 2',
    ' switchport mode trunk',
    ` channel-group 1 mode ${mode}`,
  ];
  lab.ios('SW1', 'switch-24', 232, 40, bundle('active'));
  lab.ios('SW2', 'switch-24', 616, 40, bundle('passive'));
  lab.pc('PC1', 232, 232, '192.168.1.10/24');
  lab.pc('PC2', 616, 232, '192.168.1.11/24');
  lab.cable(['SW1', 'GigabitEthernet0/1'], ['SW2', 'GigabitEthernet0/1'], undefined, '1');
  lab.cable(['SW1', 'GigabitEthernet0/2'], ['SW2', 'GigabitEthernet0/2'], undefined, '2');
  lab.cable(['PC1', 'FastEthernet0'], ['SW1', 'FastEthernet0/1']);
  lab.cable(['PC2', 'FastEthernet0'], ['SW2', 'FastEthernet0/1']);
  lab.note(
    'lacp',
    328,
    -112,
    'Both uplinks are in channel group 1. SW1 is LACP active and SW2 passive, so they bundle into Port-channel1.',
  );
  lab.note(
    'stp',
    760,
    120,
    'Spanning tree sees Port-channel1 as one port, so neither uplink blocks: both carry traffic.',
  );
  return lab.topology;
}

function portSecurityLab() {
  const lab = labBuilder('port-security');
  lab.ios('SW1', 'switch-24', 424, 40, [
    'interface FastEthernet0/1',
    ' switchport mode access',
    ' switchport port-security',
    ' switchport port-security mac-address sticky',
  ]);
  lab.pc('PC1', 232, 232, '192.168.1.10/24');
  lab.pc('PC2', 616, 232, '192.168.1.11/24');
  lab.pc('Intruder', 232, 424, '192.168.1.66/24');
  lab.cable(['PC1', 'FastEthernet0'], ['SW1', 'FastEthernet0/1']);
  lab.cable(['PC2', 'FastEthernet0'], ['SW1', 'FastEthernet0/2']);
  lab.note(
    'secure',
    544,
    -64,
    'Fa0/1 takes one MAC address, learned sticky: the first one it hears goes into the running-config.',
  );
  lab.note(
    'intruder',
    40,
    512,
    'Move PC1’s cable to the Intruder and ping from it: Fa0/1 sees a second address and err-disables.',
  );
  return lab.topology;
}

function hubCollisions() {
  const lab = labBuilder('hub-collisions');
  lab.device('Hub1', 'hub', 424, 40);
  lab.pc('PC1', 104, 232, '192.168.1.10/24');
  lab.pc('PC2', 424, 232, '192.168.1.11/24');
  lab.pc('PC3', 744, 232, '192.168.1.12/24');
  lab.cable(['PC1', 'FastEthernet0'], ['Hub1', 'Port0']);
  lab.cable(['PC2', 'FastEthernet0'], ['Hub1', 'Port1']);
  lab.cable(['PC3', 'FastEthernet0'], ['Hub1', 'Port2']);
  lab.note(
    'repeat',
    600,
    -16,
    'Hub1 repeats every frame out of every other port, so each PC sees all traffic, even frames for someone else.',
  );
  lab.note(
    'collide',
    264,
    344,
    'Its ports share one segment. In Simulation mode, ping PC3 from PC1, then from PC2, before you step: both ARP requests reach Hub1 at once, collide, and are lost.',
  );
  return lab.topology;
}

function homeWireless() {
  const lab = labBuilder('home-wireless');
  lab.ios('ISP', 'router-2g2s', 584, 40, [
    'ip dhcp excluded-address 203.0.113.1 203.0.113.9',
    'ip dhcp pool CUSTOMERS',
    ' network 203.0.113.0 255.255.255.0',
    ' default-router 203.0.113.1',
    ' dns-server 198.51.100.10',
    'interface GigabitEthernet0/0',
    ' ip address 203.0.113.1 255.255.255.0',
    ' no shutdown',
    'interface GigabitEthernet0/1',
    ' ip address 198.51.100.1 255.255.255.0',
    ' no shutdown',
  ]);
  lab.server(
    'Server1',
    904,
    40,
    '198.51.100.10/24',
    {
      dns: { enabled: false, records: [] },
      http: { enabled: true, indexHtml: '<h1>Hello from the Internet</h1>\n' },
    },
    '198.51.100.1',
  );
  lab.device('HomeRouter', 'wireless-router', 584, 264, (device) => {
    if (device.kind !== 'wirelessRouter') throw new Error('HomeRouter is not a wireless router');
    device.config.radio = {
      ssid: 'HomeNet',
      security: { mode: 'wpa2-psk', passphrase: 'tracer123' },
      channel: 6,
    };
  });
  lab.wirelessLaptop('Laptop1', 264, 456);
  lab.wirelessLaptop('Laptop2', 584, 488, { ssid: 'HomeNet', passphrase: 'tracer123' });
  lab.dhcpPc('PC1', 904, 456);
  lab.cable(['HomeRouter', 'Internet'], ['ISP', 'GigabitEthernet0/0']);
  lab.cable(['ISP', 'GigabitEthernet0/1'], ['Server1', 'GigabitEthernet0']);
  lab.cable(['PC1', 'FastEthernet0'], ['HomeRouter', 'Ethernet1']);
  lab.note(
    'wan',
    104,
    120,
    'HomeRouter’s Internet port takes 203.0.113.x from the ISP by DHCP. Its LAN, 192.168.0.0/24, reaches the Internet through PAT on that address.',
  );
  lab.note(
    'join',
    40,
    560,
    'Laptop1 has a wireless card but has joined no network. Open its PC Wireless app, join HomeNet with the key tracer123, and it gets an address by DHCP.',
  );
  lab.note(
    'server',
    904,
    232,
    'Server1 at 198.51.100.10 stands for the Internet. Ping it, or browse to it, from any laptop.',
  );
  return lab.topology;
}

export const BUILDERS: Record<string, () => Topology> = {
  'two-pcs-switch': twoPcsSwitch,
  'two-lans-router': twoLansRouter,
  'static-routes-serial': staticRoutesSerial,
  'router-on-a-stick': routerOnAStick,
  'layer3-switch': layer3Switch,
  'stp-triangle': stpTriangle,
  'dhcp-router': dhcpRouter,
  'ospf-three-routers': ospfThreeRouters,
  'eigrp-feasible-successor': eigrpFeasibleSuccessor,
  'dns-web-server': dnsWebServer,
  'pat-acl': patAcl,
  'ipv6-slaac': ipv6Slaac,
  'remote-management': remoteManagement,
  etherchannel: etherchannelLab,
  'port-security': portSecurityLab,
  'hub-collisions': hubCollisions,
  'home-wireless': homeWireless,
};
