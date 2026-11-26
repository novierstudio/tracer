/**
 * Builds each sample lab the way a student would: real catalog devices, IOS config typed line by
 * line, cables and notes. `labs.test.ts` checks every `.tracer.json` file against this, and
 * `pnpm test src/labs -u` rewrites them. Tests import it; the app never does.
 */
import { applyLines, toConfigUpdate, type IosDevice } from '@/cli';
import type { DeviceModelId } from '@/devices/catalog';
import { createDevice } from '@/devices/create';
import {
  addAnnotation,
  addDevice,
  addLink,
  AnnotationId,
  DeviceId,
  emptyTopology,
  Hostname,
  Ipv4Address,
  Ipv4Cidr,
  LinkId,
  NOTE_WIDTH,
  PortId,
  updateConfig,
  type Device,
  type Link,
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

type Cable = { cable: 'straight' | 'crossover' } | { cable: 'serial'; dce: 'a' | 'b' };

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

    pc(name: string, x: number, y: number, address: string, gateway?: string) {
      add(name, 'pc', x, y, (device) => {
        if (device.kind !== 'pc') throw new Error(`${name} is not a PC`);
        device.config.ipv4 = {
          mode: 'static',
          address: cidr(address),
          gateway: gateway === undefined ? undefined : Ipv4Address.parse(gateway),
        };
      });
    },

    /** A PC that asks a DHCP server for its address. */
    dhcpPc(name: string, x: number, y: number) {
      add(name, 'pc', x, y, (device) => {
        if (device.kind !== 'pc') throw new Error(`${name} is not a PC`);
        device.config.ipv4 = { mode: 'dhcp' };
      });
    },

    cable(a: [string, string], b: [string, string], kind: Cable = { cable: 'straight' }) {
      const link = {
        id: LinkId.parse(`lnk_${tag}${a[0]}${b[0]}`),
        a: { device: deviceId(a[0]), port: PortId.parse(a[1]) },
        b: { device: deviceId(b[0]), port: PortId.parse(b[1]) },
        ...kind,
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
  lab.cable(['PC1', 'FastEthernet0'], ['R1', 'GigabitEthernet0/0'], { cable: 'crossover' });
  lab.cable(['R1', 'Serial0/0/0'], ['R2', 'Serial0/0/0'], { cable: 'serial', dce: 'a' });
  lab.cable(['R2', 'GigabitEthernet0/0'], ['PC2', 'FastEthernet0'], { cable: 'crossover' });
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
  lab.cable(['R1', 'GigabitEthernet0/1'], ['R2', 'GigabitEthernet0/1'], { cable: 'crossover' });
  lab.cable(['R2', 'GigabitEthernet0/2'], ['R3', 'GigabitEthernet0/1'], { cable: 'crossover' });
  lab.cable(['R1', 'Serial0/0/0'], ['R3', 'Serial0/0/0'], { cable: 'serial', dce: 'a' });
  lab.cable(['PC1', 'FastEthernet0'], ['R1', 'GigabitEthernet0/0'], { cable: 'crossover' });
  lab.cable(['PC2', 'FastEthernet0'], ['R2', 'GigabitEthernet0/0'], { cable: 'crossover' });
  lab.cable(['PC3', 'FastEthernet0'], ['R3', 'GigabitEthernet0/0'], { cable: 'crossover' });
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

export const BUILDERS: Record<string, () => Topology> = {
  'two-pcs-switch': twoPcsSwitch,
  'two-lans-router': twoLansRouter,
  'static-routes-serial': staticRoutesSerial,
  'router-on-a-stick': routerOnAStick,
  'stp-triangle': stpTriangle,
  'dhcp-router': dhcpRouter,
  'ospf-three-routers': ospfThreeRouters,
};
