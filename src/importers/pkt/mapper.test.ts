import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createIdSource,
  Hostname,
  Topology,
  type Device,
  type Endpoint,
  type RouterConfig,
} from '@/model';
import { encryptPkt } from './codec';
import {
  importPkt,
  keepLinesAsUnknown,
  mapPktXml,
  type MapOptions,
  type PktImport,
  type ReplayConfig,
} from './mapper';
import type { ReportEntry } from './report';

const NOW = new Date('2026-11-25T00:00:00.000Z');
const options = (extra: MapOptions = {}): MapOptions => ({
  ids: createIdSource(7),
  now: NOW,
  ...extra,
});

function imported(xml: string, extra?: MapOptions): PktImport {
  const result = mapPktXml(xml, options(extra));
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

function fixture(name: string): PktImport {
  const path = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', name);
  const result = importPkt(readFileSync(path), options());
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

function expectValid(topology: Topology) {
  const parsed = Topology.safeParse(topology);
  expect(parsed.error && z.prettifyError(parsed.error)).toBeUndefined();
}

const byHostname = (topology: Topology, hostname: string): Device => {
  const device = Object.values(topology.devices).find((d) => d.config.hostname === hostname);
  if (!device) throw new Error(`No device ${hostname}`);
  return device;
};

const linkEnds = (topology: Topology) =>
  Object.values(topology.links).map((link) => {
    const end = ({ device, port }: Endpoint) =>
      `${topology.devices[device]?.config.hostname} ${port}`;
    return `${link.cable}: ${end(link.a)} - ${end(link.b)}`;
  });

const entriesOf = <K extends ReportEntry['kind']>({ report }: PktImport, kind: K) =>
  report.entries.filter((entry): entry is Extract<ReportEntry, { kind: K }> => entry.kind === kind);

// Synthetic Packet Tracer XML, shaped like the real files.

type PortSpec = {
  type?: string;
  mac?: string;
  power?: boolean;
  ip?: string;
  subnet?: string;
  gateway?: string;
  dns?: string;
  dhcp?: boolean;
};

type DeviceSpec = {
  type: string;
  name: string;
  model?: string;
  ref?: string;
  x?: number;
  y?: number;
  /** Ports on the main board, in chassis slot 0. */
  ports?: PortSpec[];
  /** Modules in the board's slots. Packet Tracer writes them before the board's own ports. */
  slots?: PortSpec[][];
  config?: string[];
  gateway?: string;
  vlans?: [number, string][];
};

const escape = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

let macCounter = 0;
const nextMac = () => `0001.0000.${(++macCounter).toString(16).padStart(4, '0')}`;

const portXml = (p: PortSpec) =>
  `<PORT><TYPE>${p.type ?? 'eCopperFastEthernet'}</TYPE><POWER>${p.power ?? true}</POWER>` +
  `<MACADDRESS>${p.mac ?? nextMac()}</MACADDRESS><IP>${p.ip ?? ''}</IP><SUBNET>${p.subnet ?? ''}</SUBNET>` +
  `<PORT_GATEWAY>${p.gateway ?? ''}</PORT_GATEWAY><PORT_DNS>${p.dns ?? ''}</PORT_DNS>` +
  `<PORT_DHCP_ENABLE>${p.dhcp ?? false}</PORT_DHCP_ENABLE></PORT>`;

const deviceXml = (d: DeviceSpec) =>
  `<DEVICE><ENGINE><TYPE customModel="" model="${escape(d.model ?? `${d.type}-PT`)}">${d.type}</TYPE>` +
  `<NAME translate="true">${escape(d.name)}</NAME><POWER>true</POWER>` +
  `<MODULE><TYPE>eNonRemovableModule</TYPE><SLOT><MODULE>` +
  (d.slots ?? [])
    .map((ports) => `<SLOT><MODULE>${ports.map(portXml).join('')}</MODULE></SLOT>`)
    .join('') +
  (d.ports ?? []).map(portXml).join('') +
  `</MODULE></SLOT></MODULE>` +
  (d.ref ? `<SAVE_REF_ID>${d.ref}</SAVE_REF_ID>` : '') +
  `<GATEWAY>${d.gateway ?? ''}</GATEWAY>` +
  `<RUNNINGCONFIG>${(d.config ?? []).map((l) => `<LINE>${escape(l)}</LINE>`).join('')}</RUNNINGCONFIG>` +
  (d.vlans
    ? `<VLANS>${d.vlans.map(([n, name]) => `<VLAN number="${n}" name="${name}"/>`).join('')}</VLANS>`
    : '') +
  `</ENGINE><WORKSPACE><LOGICAL><X>${d.x ?? 0}</X><Y>${d.y ?? 0}</Y></LOGICAL></WORKSPACE></DEVICE>`;

type LinkSpec = {
  from: string;
  fromPort: string;
  to: string;
  toPort: string;
  cable?: string;
  serial?: boolean;
  dce?: string;
};

const linkXml = (l: LinkSpec) =>
  `<LINK><TYPE>${l.serial ? 'eSerial' : 'eCopper'}</TYPE><CABLE><FROM>${l.from}</FROM><PORT>${l.fromPort}</PORT>` +
  `<TO>${l.to}</TO><PORT>${l.toPort}</PORT>` +
  (l.cable ? `<TYPE>${l.cable}</TYPE>` : '') +
  (l.dce
    ? `<DCEDEV>${l.dce}</DCEDEV><DCEPORT>${l.dce === l.from ? l.fromPort : l.toPort}</DCEPORT>`
    : '') +
  `</CABLE></LINK>`;

const networkXml = (devices: DeviceSpec[], links: LinkSpec[] = []) =>
  `<PACKETTRACER5><VERSION>8.2.2.0400</VERSION><NETWORK><DEVICES>${devices.map(deviceXml).join('')}</DEVICES>` +
  `<LINKS>${links.map(linkXml).join('')}</LINKS></NETWORK></PACKETTRACER5>`;

const pc = (name: string, extra: Partial<DeviceSpec> = {}): DeviceSpec => ({
  type: 'Pc',
  name,
  model: 'PC-PT',
  ports: [{}],
  ...extra,
});

const fastSwitch = (name: string, extra: Partial<DeviceSpec> = {}): DeviceSpec => ({
  type: 'Switch',
  name,
  model: '2960-24TT',
  ports: [{}, {}],
  config: [
    'hostname Switch',
    'interface FastEthernet0/1',
    'interface FastEthernet0/2',
    'interface Vlan1',
    ' no ip address',
  ],
  ...extra,
});

describe('mapPktXml', () => {
  it('imports routers, switches, PCs, laptops and servers, and skips other device types', () => {
    const result = imported(
      networkXml([
        { type: 'Router', name: 'R1', model: '2811' },
        fastSwitch('S1'),
        pc('PC1'),
        { type: 'Laptop', name: 'L1', model: 'Laptop-PT', ports: [{}] },
        { type: 'Server', name: 'Srv1', model: 'Server-PT', ports: [{}] },
        { type: 'Printer', name: 'Printer0', model: 'Printer-PT', ports: [{}] },
      ]),
    );
    const kinds = Object.values(result.topology.devices).map((d) => [
      d.config.hostname,
      d.kind,
      d.model,
    ]);
    expect(kinds).toEqual([
      ['R1', 'router', '2811'],
      ['S1', 'switch', '2960-24TT'],
      ['PC1', 'pc', 'PC-PT'],
      ['L1', 'pc', 'Laptop-PT'],
      ['Srv1', 'server', 'Server-PT'],
    ]);
    expect(result.report.devices).toEqual({ imported: 5, skipped: 1 });
    expect(entriesOf(result, 'device-skipped')).toEqual([
      { kind: 'device-skipped', name: 'Printer0', ptType: 'Printer', model: 'Printer-PT' },
    ]);
    expectValid(result.topology);
  });

  it('drops a link to a skipped device and reports it', () => {
    const result = imported(
      networkXml(
        [fastSwitch('S1'), { type: 'Printer', name: 'Printer0', ports: [{}] }, pc('PC1')],
        [
          {
            from: '1',
            fromPort: 'FastEthernet0',
            to: '0',
            toPort: 'FastEthernet0/1',
            cable: 'eStraightThrough',
          },
          {
            from: '2',
            fromPort: 'FastEthernet0',
            to: '0',
            toPort: 'FastEthernet0/2',
            cable: 'eStraightThrough',
          },
        ],
      ),
    );
    expect(result.report.links).toEqual({ imported: 1, dropped: 1 });
    expect(entriesOf(result, 'link-dropped')).toEqual([
      {
        kind: 'link-dropped',
        from: { device: 'Printer0', port: 'FastEthernet0' },
        to: { device: 'S1', port: 'FastEthernet0/1' },
        reason: { kind: 'device-skipped' },
      },
    ]);
    expectValid(result.topology);
  });

  it('resolves link ends by device index and by save-ref-id', () => {
    const devices = [
      pc('PC1', { ref: 'save-ref-id:111' }),
      fastSwitch('S1', { ref: 'save-ref-id:222' }),
    ];
    const byIndex = imported(
      networkXml(devices, [
        {
          from: '0',
          fromPort: 'FastEthernet0',
          to: '1',
          toPort: 'FastEthernet0/2',
          cable: 'eStraightThrough',
        },
      ]),
    );
    const byRef = imported(
      networkXml(devices, [
        {
          from: 'save-ref-id:111',
          fromPort: 'FastEthernet0',
          to: 'save-ref-id:222',
          toPort: 'FastEthernet0/2',
          cable: 'eStraightThrough',
        },
      ]),
    );
    for (const { topology } of [byIndex, byRef]) {
      const [link] = Object.values(topology.links);
      expect(link).toMatchObject({
        cable: 'straight',
        a: { device: byHostname(topology, 'PC1').id, port: 'FastEthernet0' },
        b: { device: byHostname(topology, 'S1').id, port: 'FastEthernet0/2' },
      });
    }
  });

  it('pairs router ports with running-config interfaces even when module slots come first in the file', () => {
    const { topology } = imported(
      networkXml([
        {
          type: 'Router',
          name: 'R1',
          model: '2911',
          slots: [
            [
              { type: 'eSmartSerial', ip: '10.0.0.1', subnet: '255.255.255.252' },
              { type: 'eSmartSerial', power: false },
            ],
          ],
          ports: [
            {
              type: 'eCopperGigabitEthernet',
              ip: '192.168.1.1',
              subnet: '255.255.255.0',
              mac: '00E0.F7AA.0001',
            },
            { type: 'eCopperGigabitEthernet', power: false },
          ],
          config: [
            'hostname R1',
            '!',
            'interface GigabitEthernet0/0',
            ' ip address 192.168.1.1 255.255.255.0',
            'interface GigabitEthernet0/1',
            ' shutdown',
            'interface Serial0/0/0',
            ' ip address 10.0.0.1 255.255.255.252',
            'interface Serial0/0/1',
            ' shutdown',
            'interface Vlan1',
          ],
        },
      ]),
    );
    const router = byHostname(topology, 'R1');
    expect(router.ports).toEqual([
      { kind: 'gigabitEthernet', id: 'GigabitEthernet0/0', mac: '00:e0:f7:aa:00:01' },
      { kind: 'gigabitEthernet', id: 'GigabitEthernet0/1', mac: expect.any(String) },
      { kind: 'serial', id: 'Serial0/0/0' },
      { kind: 'serial', id: 'Serial0/0/1' },
    ]);
    expect((router.config as RouterConfig).interfaces).toEqual({
      'GigabitEthernet0/0': { shutdown: false, ipv4: { address: '192.168.1.1', prefixLength: 24 } },
      'GigabitEthernet0/1': { shutdown: true },
      'Serial0/0/0': { shutdown: false, ipv4: { address: '10.0.0.1', prefixLength: 30 } },
      'Serial0/0/1': { shutdown: true },
    });
    expectValid(topology);
  });

  it('names router ports from their slots, and says so, when there is no running-config', () => {
    const result = imported(
      networkXml([
        {
          type: 'Router',
          name: 'R1',
          slots: [[{ type: 'eSerial' }]],
          ports: [{ type: 'eCopperFastEthernet' }, { type: 'eCopperFastEthernet' }],
        },
      ]),
    );
    const router = byHostname(result.topology, 'R1');
    expect(router.ports.map((p) => p.id)).toEqual([
      'FastEthernet0/0',
      'FastEthernet0/1',
      'Serial0/0/0',
    ]);
    expect(entriesOf(result, 'port-names-guessed')).toEqual([
      { kind: 'port-names-guessed', device: router.id },
    ]);
  });

  it('reads a host IP address, mask, gateway and DNS server from its port', () => {
    const { topology } = imported(
      networkXml([
        pc('Static', {
          ports: [
            {
              ip: '192.168.10.5',
              subnet: '255.255.255.0',
              gateway: '192.168.10.1',
              dns: '8.8.8.8',
            },
          ],
        }),
        pc('Dynamic', { ports: [{ dhcp: true }] }),
        // Packet Tracer 5.x keeps the gateway on the device.
        pc('Old', { ports: [{ ip: '10.0.0.2', subnet: '255.0.0.0' }], gateway: '10.0.0.1' }),
      ]),
    );
    expect(byHostname(topology, 'Static').config).toEqual({
      hostname: 'Static',
      ipv4: {
        mode: 'static',
        address: { address: '192.168.10.5', prefixLength: 24 },
        gateway: '192.168.10.1',
        dns: '8.8.8.8',
      },
    });
    expect(byHostname(topology, 'Dynamic').config).toEqual({
      hostname: 'Dynamic',
      ipv4: { mode: 'dhcp' },
    });
    expect(byHostname(topology, 'Old').config).toMatchObject({
      ipv4: { address: { address: '10.0.0.2', prefixLength: 8 }, gateway: '10.0.0.1' },
    });
    expectValid(topology);
  });

  it('turns canvas labels into unique IOS hostnames and records the original names', () => {
    const labels = [
      'PC 1',
      'Web Server',
      'PC1',
      'pc1',
      'Café',
      '路由器',
      '1st floor',
      'PC1-2',
      'x'.repeat(70),
    ];
    const result = imported(networkXml(labels.map((name) => pc(name))));
    const hostnames = Object.values(result.topology.devices).map((d) => d.config.hostname);
    expect(hostnames).toEqual([
      'PC-1',
      'Web-Server',
      'PC1',
      'pc1-2',
      'Cafe',
      'PC',
      'PC-1st-floor',
      'PC1-2-2',
      'x'.repeat(63),
    ]);
    expect(
      entriesOf(result, 'hostname-changed').map(({ name, hostname }) => [name, hostname]),
    ).toEqual([
      ['PC 1', 'PC-1'],
      ['Web Server', 'Web-Server'],
      ['pc1', 'pc1-2'],
      ['Café', 'Cafe'],
      ['路由器', 'PC'],
      ['1st floor', 'PC-1st-floor'],
      ['PC1-2', 'PC1-2-2'],
      ['x'.repeat(70), 'x'.repeat(63)],
    ]);
    expectValid(result.topology);
  });

  it('imports only the first network of a .pka activity', () => {
    const network = (name: string) =>
      `<PACKETTRACER5><VERSION>9.0.1.0858</VERSION><NETWORK><DEVICES>${deviceXml(pc(name))}</DEVICES><LINKS/></NETWORK></PACKETTRACER5>`;
    const xml =
      `<PACKETTRACER5_ACTIVITY><VERSION>9.0.1.0858</VERSION>` +
      network('Mine') +
      network('Initial') +
      network('Answer') +
      `<COMPARISONS><NODE><NAME>Answer</NAME></NODE></COMPARISONS><INITIALSETUP><NODE/></INITIALSETUP>` +
      `</PACKETTRACER5_ACTIVITY>`;
    const result = imported(xml);
    expect(Object.values(result.topology.devices).map((d) => d.config.hostname)).toEqual(['Mine']);
    expect(result.report).toMatchObject({ ptVersion: '9.0.1.0858', activity: true });
    expect(JSON.stringify(result)).not.toMatch(/Answer|Initial/);
  });

  it('moves the layout to the origin and keeps relative positions, ignoring skipped devices', () => {
    const { topology } = imported(
      networkXml([
        pc('A', { x: 300.5, y: 200 }),
        { type: 'Power Distribution Device', name: 'Power', x: 3900, y: 3900 },
        pc('B', { x: 450, y: 180 }),
      ]),
    );
    expect(byHostname(topology, 'A').position).toEqual({ x: 0, y: 20 });
    expect(byHostname(topology, 'B').position).toEqual({ x: 149.5, y: 0 });
  });

  it('applies the running-config through the IOS commands by default', () => {
    const result = imported(networkXml([fastSwitch('S1')]));
    const device = byHostname(result.topology, 'S1');
    expect(device.config).toMatchObject({ hostname: 'S1', unknownLines: [] });
    expect(device.kind === 'switch' && device.config.virtualInterfaces).toHaveProperty('Vlan1');
    expect(entriesOf(result, 'config-kept')).toEqual([]);
  });

  it('keeps running-config lines verbatim with keepLinesAsUnknown', () => {
    const result = imported(networkXml([fastSwitch('S1')]), { replayConfig: keepLinesAsUnknown });
    const device = byHostname(result.topology, 'S1');
    const lines = [
      'hostname Switch',
      'interface FastEthernet0/1',
      'interface FastEthernet0/2',
      'interface Vlan1',
      ' no ip address',
    ];
    expect(device.config).toMatchObject({ hostname: 'S1', unknownLines: lines });
    expect(entriesOf(result, 'config-kept')).toEqual([
      { kind: 'config-kept', device: device.id, lines },
    ]);
  });

  it('replays the running-config through replayConfig and keeps the canvas label as hostname', () => {
    const calls: { config: unknown; lines: readonly string[] }[] = [];
    const replayConfig: ReplayConfig = (device, lines) => {
      calls.push({ config: device.config, lines });
      const hostname = Hostname.parse('FromConfig');
      return { ...device.config, hostname, unknownLines: ['banner motd #hi#'] };
    };
    const result = imported(
      networkXml([
        {
          type: 'Router',
          name: 'R1',
          ports: [{ ip: '10.0.0.1', subnet: '255.0.0.0' }],
          config: [
            '!',
            'hostname FromConfig',
            'interface FastEthernet0/0',
            ' ip address 10.0.0.1 255.0.0.0',
            '',
            'end',
          ],
        },
      ]),
      { replayConfig },
    );
    expect(calls).toMatchObject([
      {
        config: {
          hostname: 'R1',
          interfaces: {
            'FastEthernet0/0': { shutdown: false, ipv4: { address: '10.0.0.1', prefixLength: 8 } },
          },
          unknownLines: [],
        },
        lines: [
          'hostname FromConfig',
          'interface FastEthernet0/0',
          ' ip address 10.0.0.1 255.0.0.0',
          'end',
        ],
      },
    ]);
    const router = byHostname(result.topology, 'R1');
    expect(router.config).toMatchObject({ hostname: 'R1', unknownLines: ['banner motd #hi#'] });
    expect(entriesOf(result, 'config-kept')).toEqual([
      { kind: 'config-kept', device: router.id, lines: ['banner motd #hi#'] },
    ]);
  });

  it('imports a multilayer switch as one that routes, with nothing approximated', () => {
    const result = imported(
      networkXml([fastSwitch('MLS', { type: 'MultiLayerSwitch', model: '3560-24PS' })]),
    );
    const device = byHostname(result.topology, 'MLS');
    expect(device).toMatchObject({ kind: 'switch', model: 'switch-l3-24' });
    expect(entriesOf(result, 'device-approximated')).toEqual([]);
  });

  it('reads switch VLANs, leaving out the ones IOS creates itself', () => {
    const { topology } = imported(
      networkXml([
        fastSwitch('S1', {
          vlans: [
            [1, 'default'],
            [10, 'Sales'],
            [1002, 'fddi-default'],
          ],
        }),
      ]),
    );
    expect(byHostname(topology, 'S1').config).toMatchObject({
      vlans: { 1: { name: 'default' }, 10: { name: 'Sales' } },
    });
    expect(byHostname(topology, 'S1').config).not.toHaveProperty('vlans.1002');
  });

  it('maps serial links with their DCE end, and an unknown cable type to one that fits the ports', () => {
    const router = (name: string): DeviceSpec => ({
      type: 'Router',
      name,
      slots: [[{ type: 'eSerial' }]],
      ports: [{ type: 'eCopperFastEthernet' }],
      config: ['interface FastEthernet0/0', 'interface Serial0/0/0'],
    });
    const result = imported(
      networkXml(
        [router('R1'), router('R2')],
        [
          {
            from: '0',
            fromPort: 'Serial0/0/0',
            to: '1',
            toPort: 'Serial0/0/0',
            serial: true,
            dce: '1',
          },
          {
            from: '0',
            fromPort: 'FastEthernet0/0',
            to: '1',
            toPort: 'FastEthernet0/0',
            cable: 'eFiber',
          },
        ],
      ),
    );
    const [serial, copper] = Object.values(result.topology.links);
    expect(serial).toMatchObject({ cable: 'serial', dce: 'b' });
    expect(copper).toMatchObject({ cable: 'straight' });
    expect(entriesOf(result, 'cable-approximated')).toEqual([
      { kind: 'cable-approximated', link: copper!.id, ptCable: 'eFiber', cable: 'straight' },
    ]);
    expectValid(result.topology);
  });

  it("resolves a Packet Tracer 5.x link to a host's unnumbered port", () => {
    const { topology, report } = imported(
      networkXml(
        [pc('PC1'), fastSwitch('S1')],
        [
          {
            from: '0',
            fromPort: 'FastEthernet',
            to: '1',
            toPort: 'FastEthernet0/1',
            cable: 'eStraightThrough',
          },
        ],
      ),
    );
    expect(report.links).toEqual({ imported: 1, dropped: 0 });
    expect(Object.values(topology.links)[0]?.a.port).toBe('FastEthernet0');
  });

  it('skips ports Tracer has no kind for and drops their links', () => {
    const result = imported(
      networkXml(
        [
          { type: 'Laptop', name: 'L1', ports: [{ type: 'eHostWirelessN' }] },
          { type: 'Router', name: 'R1', ports: [{}], config: ['interface FastEthernet0/0'] },
          pc('PC1'),
        ],
        [{ from: '2', fromPort: 'RS 232', to: '1', toPort: 'Console', cable: 'eRollOver' }],
      ),
    );
    expect(byHostname(result.topology, 'L1').ports).toEqual([]);
    expect(entriesOf(result, 'port-skipped')).toMatchObject([{ ptType: 'eHostWirelessN' }]);
    expect(entriesOf(result, 'link-dropped')).toMatchObject([
      { reason: { kind: 'port-not-imported' } },
    ]);
  });

  it('rejects XML that is not a Packet Tracer network', () => {
    expect(mapPktXml('<html><body/></html>')).toEqual({
      ok: false,
      error: { kind: 'not-packet-tracer' },
    });
  });
});

describe('importPkt', () => {
  it('reports a file that does not decrypt', () => {
    const result = importPkt(new Uint8Array(64).fill(7));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.kind).toBe('decrypt-failed');
  });

  it('decrypts and maps a file', () => {
    const result = importPkt(encryptPkt(networkXml([pc('PC1')])), options());
    expect(result.ok && Object.values(result.value.topology.devices).map((d) => d.kind)).toEqual([
      'pc',
    ]);
  });

  it('announces each step as it starts', () => {
    const stages: string[] = [];
    importPkt(encryptPkt(networkXml([pc('PC1')])), {
      ...options(),
      onStage: (stage) => stages.push(stage),
    });
    expect(stages).toEqual(['decrypting', 'decompressing', 'mapping']);

    stages.length = 0;
    importPkt(new Uint8Array(64).fill(7), { onStage: (stage) => stages.push(stage) });
    expect(stages).toEqual(['decrypting']);
  });

  describe('Packet Tracer 7.1 EIGRP lab (links by device index)', () => {
    const eigrp = fixture('pt7.1-eigrp-lab.pkt');

    it('imports the four routers and skips the power distribution device', () => {
      const result = eigrp;
      expect(result.report).toMatchObject({
        ptVersion: '7.1.0.0222',
        activity: false,
        devices: { imported: 4, skipped: 1 },
        links: { imported: 3, dropped: 0 },
      });
      const devices = Object.values(result.topology.devices);
      expect(devices.map((d) => [d.config.hostname, d.kind, d.model])).toEqual([
        ['Router1', 'router', 'ISR4321'],
        ['Router2', 'router', 'ISR4321'],
        ['Router3', 'router', '1941'],
        ['Router4', 'router', '1941'],
      ]);
      expect(entriesOf(result, 'device-skipped')).toEqual([
        {
          kind: 'device-skipped',
          name: 'Power Distribution Device0',
          ptType: 'Power Distribution Device',
          model: 'Power Distribution Device',
        },
      ]);
    });

    it('resolves every link to its routers and ports', () => {
      expect(linkEnds(eigrp.topology)).toEqual([
        'straight: Router1 GigabitEthernet0/0/0 - Router2 GigabitEthernet0/0/0',
        'straight: Router2 GigabitEthernet0/0/1 - Router3 GigabitEthernet0/1',
        'straight: Router3 GigabitEthernet0/0 - Router4 GigabitEthernet0/0',
      ]);
    });

    it('moves the routers to the origin, keeping their layout', () => {
      // LOGICAL X/Y in the file: (202, 169), (483, 171), (776.5, 171), (1051.5, 171).
      expect(Object.values(eigrp.topology.devices).map((d) => d.position)).toEqual([
        { x: 0, y: 0 },
        { x: 281, y: 2 },
        { x: 574.5, y: 2 },
        { x: 849.5, y: 2 },
      ]);
    });

    it('fills interface addresses and shutdown state from the ports', () => {
      expect((byHostname(eigrp.topology, 'Router1').config as RouterConfig).interfaces).toEqual({
        'GigabitEthernet0/0/0': {
          shutdown: false,
          ipv4: { address: '10.1.1.1', prefixLength: 24 },
        },
        'GigabitEthernet0/0/1': { shutdown: true },
      });
    });

    it('replays each running-config, keeping only the lines Tracer does not support yet', () => {
      const kept = entriesOf(eigrp, 'config-kept');
      expect(kept).toHaveLength(4);
      expect(kept[0]?.lines).toContain('ip cef');
      expect(kept[0]?.lines).not.toContain('hostname R1');
      expect(kept[0]?.lines).not.toContain(' ip address 10.1.1.1 255.255.255.0');
    });

    it('passes the Topology schema', () => {
      expectValid(eigrp.topology);
    });
  });

  describe('Packet Tracer 8.2 VTP lab (links by save-ref-id)', () => {
    const vtp = fixture('pt8.2-vtp-lab.pkt');

    it('imports the three switches with their 26 ports and file MAC addresses', () => {
      const { topology, report } = vtp;
      expect(report).toMatchObject({
        ptVersion: '8.2.2.0400',
        devices: { imported: 3, skipped: 1 },
        links: { imported: 2, dropped: 0 },
      });
      const sw1 = byHostname(topology, 'SW1');
      expect(sw1).toMatchObject({ kind: 'switch', model: '2960-24TT', position: { x: 0, y: 0 } });
      expect(sw1.ports).toHaveLength(26);
      expect(sw1.ports[0]).toEqual({
        kind: 'fastEthernet',
        id: 'FastEthernet0/1',
        mac: '00:01:64:77:73:01',
      });
      expect(sw1.ports.slice(-2).map((p) => p.id)).toEqual([
        'GigabitEthernet0/1',
        'GigabitEthernet0/2',
      ]);
      expect(byHostname(topology, 'SW3').position).toEqual({ x: 302, y: 2 });
      expect(sw1.config).toMatchObject({ vlans: { 1: { name: 'default' } } });
    });

    it('resolves every link to its switches and ports', () => {
      expect(linkEnds(vtp.topology)).toEqual([
        'straight: SW1 FastEthernet0/1 - SW2 FastEthernet0/1',
        'straight: SW2 FastEthernet0/2 - SW3 FastEthernet0/1',
      ]);
    });

    it('passes the Topology schema', () => {
      expectValid(vtp.topology);
    });
  });
});
