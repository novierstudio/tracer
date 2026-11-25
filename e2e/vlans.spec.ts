import { expect, test, type Page } from '@playwright/test';
import { select, terminalIn } from './lab';

test.use({ viewport: { width: 1440, height: 900 } });

type PingEvent = { kind: string; from?: string; ttl?: number; received?: number };

/** The dev handles on `window`, as far as this test uses them. */
type DevWindow = {
  __TRACER_DEV__?: boolean;
  tracer: {
    loadLab(input: unknown): void;
    editorStore: { getState(): { load(topology: unknown): void } };
  };
  tracerSim: {
    ping(
      device: string,
      target: string,
      options: { count: number; timeoutMs: number },
      listener: (event: PingEvent) => void,
    ): Promise<{ ok: boolean; error?: string }>;
  };
};

const mac = (n: number) => `02:00:00:00:00:${n.toString(16).padStart(2, '0')}`;

function pc(id: string, n: number, address: string, gateway: string) {
  return {
    id,
    kind: 'pc',
    model: 'pc',
    position: { x: n * 200, y: 300 },
    powered: true,
    ports: [{ kind: 'fastEthernet', id: 'FastEthernet0', mac: mac(n) }],
    config: {
      hostname: id.slice(4),
      ipv4: { mode: 'static', address: { address, prefixLength: 24 }, gateway },
    },
  };
}

const accessPort = { shutdown: false, switchport: { mode: 'access', vlan: 1 } };

const link = (id: string, a: [string, string], b: [string, string]) => ({
  id,
  cable: 'straight',
  a: { device: a[0], port: a[1] },
  b: { device: b[0], port: b[1] },
});

/** Two PCs on SW1 and R1 on SW1's Gi0/1, every IOS device at factory defaults. */
const LAB = {
  version: 1,
  meta: {
    name: 'Router on a stick',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  devices: {
    dev_PC1: pc('dev_PC1', 1, '192.168.10.10', '192.168.10.1'),
    dev_PC2: pc('dev_PC2', 2, '192.168.20.10', '192.168.20.1'),
    dev_SW1: {
      id: 'dev_SW1',
      kind: 'switch',
      model: 'switch',
      position: { x: 300, y: 150 },
      powered: true,
      ports: [
        { kind: 'fastEthernet', id: 'FastEthernet0/1', mac: mac(0x11) },
        { kind: 'fastEthernet', id: 'FastEthernet0/2', mac: mac(0x12) },
        { kind: 'gigabitEthernet', id: 'GigabitEthernet0/1', mac: mac(0x13) },
      ],
      config: {
        hostname: 'SW1',
        interfaces: {
          'FastEthernet0/1': accessPort,
          'FastEthernet0/2': accessPort,
          'GigabitEthernet0/1': accessPort,
        },
        vlans: { 1: { name: 'default' } },
        virtualInterfaces: { Vlan1: { shutdown: true } },
        unknownLines: [],
      },
    },
    dev_R1: {
      id: 'dev_R1',
      kind: 'router',
      model: 'router',
      position: { x: 300, y: 0 },
      powered: true,
      ports: [
        { kind: 'gigabitEthernet', id: 'GigabitEthernet0/0', mac: mac(0x31) },
        { kind: 'gigabitEthernet', id: 'GigabitEthernet0/1', mac: mac(0x32) },
      ],
      config: {
        hostname: 'R1',
        interfaces: {
          'GigabitEthernet0/0': { shutdown: true },
          'GigabitEthernet0/1': { shutdown: true },
        },
        unknownLines: [],
      },
    },
  },
  links: {
    lnk_1: link('lnk_1', ['dev_PC1', 'FastEthernet0'], ['dev_SW1', 'FastEthernet0/1']),
    lnk_2: link('lnk_2', ['dev_PC2', 'FastEthernet0'], ['dev_SW1', 'FastEthernet0/2']),
    lnk_3: link('lnk_3', ['dev_SW1', 'GigabitEthernet0/1'], ['dev_R1', 'GigabitEthernet0/0']),
  },
  annotations: {},
};

const R1_CONFIG = [
  'enable',
  'configure terminal',
  'interface g0/0',
  'no shutdown',
  'interface g0/0.10',
  'encapsulation dot1Q 10',
  'ip address 192.168.10.1 255.255.255.0',
  'interface g0/0.20',
  'encapsulation dot1Q 20',
  'ip address 192.168.20.1 255.255.255.0',
  'end',
];

const SW1_CONFIG = [
  'enable',
  'configure terminal',
  'vlan 10',
  'name Sales',
  'vlan 20',
  'name Staff',
  'interface f0/1',
  'switchport mode access',
  'switchport access vlan 10',
  'interface f0/2',
  'switchport mode access',
  'switchport access vlan 20',
  'interface g0/1',
  'switchport mode trunk',
  'end',
];

async function openLab(page: Page) {
  await page.addInitScript(() => {
    (window as unknown as DevWindow).__TRACER_DEV__ = true;
  });
  await page.goto('./');
  await expect(page.getByRole('contentinfo').getByRole('status')).toHaveText('Engine ready');
  await page.evaluate((topology) => {
    const { tracer } = window as unknown as DevWindow;
    tracer.loadLab(topology);
  }, LAB);
}

function ping(page: Page, from: string, target: string) {
  return page.evaluate(
    ([device, address]) =>
      new Promise<PingEvent[]>((resolve, reject) => {
        const events: PingEvent[] = [];
        void (window as unknown as DevWindow).tracerSim
          .ping(device!, address!, { count: 2, timeoutMs: 1000 }, (event) => {
            events.push(event);
            if (event.kind === 'summary') resolve(events);
          })
          .then((started) => {
            if (!started.ok) reject(new Error(`ping did not start: ${started.error}`));
          });
      }),
    [from, target],
  );
}

test('builds router-on-a-stick from the CLI and shows its live routes and MAC table', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openLab(page);
  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  const cli = terminalIn(page, inspector);

  /** Pastes a config into the selected device's CLI and waits for the last prompt. */
  const paste = async (device: string, lines: string[], prompt: string) => {
    await select(page, device);
    await inspector.getByRole('tab', { name: 'CLI' }).click();
    await cli.input.focus();
    await page.evaluate((text) => navigator.clipboard.writeText(text), `${lines.join('\n')}\n`);
    await page.keyboard.press('ControlOrMeta+V');
    await expect.poll(cli.lastRow).toBe(prompt);
  };
  await paste('dev_R1', R1_CONFIG, 'R1#');
  await paste('dev_SW1', SW1_CONFIG, 'SW1#');

  const events = await ping(page, 'dev_PC1', '192.168.20.10');
  expect(events).toEqual([
    expect.objectContaining({ kind: 'reply', from: '192.168.20.10', ttl: 127 }),
    expect.objectContaining({ kind: 'reply', from: '192.168.20.10', ttl: 127 }),
    expect.objectContaining({ kind: 'summary', received: 2 }),
  ]);

  // The inspector is narrower than IOS output, so rows wrap; compare text with spaces removed.
  // Unit tests pin the column layout.
  const shown = async () => (await cli.rows()).join('').replace(/\s+/g, '');
  const text = (lines: string[]) => lines.join('').replace(/\s+/g, '');
  /** Runs a show command. Its echo can scroll out of view, so wait for the output instead. */
  const showCommand = async (line: string, expected: string[]) => {
    await page.keyboard.type(line);
    await page.keyboard.press('Enter');
    await expect.poll(shown).toContain(text(expected));
  };

  await showCommand('show mac address-table', [
    'Vlan    Mac Address       Type        Ports',
    '----    -----------       --------    -----',
    '  10    0200.0000.0001    DYNAMIC     Fa0/1',
    '  10    0200.0000.0031    DYNAMIC     Gi0/1',
    '  20    0200.0000.0002    DYNAMIC     Fa0/2',
    '  20    0200.0000.0031    DYNAMIC     Gi0/1',
    'Total Mac Addresses for this criterion: 4',
    'SW1#',
  ]);

  await select(page, 'dev_R1');
  await cli.input.focus();
  await showCommand('show ip route', [
    'Gateway of last resort is not set',
    '      192.168.10.0/24 is variably subnetted, 2 subnets, 2 masks',
    'C        192.168.10.0/24 is directly connected, GigabitEthernet0/0.10',
    'L        192.168.10.1/32 is directly connected, GigabitEthernet0/0.10',
    '      192.168.20.0/24 is variably subnetted, 2 subnets, 2 masks',
    'C        192.168.20.0/24 is directly connected, GigabitEthernet0/0.20',
    'L        192.168.20.1/32 is directly connected, GigabitEthernet0/0.20',
    'R1#',
  ]);
});
