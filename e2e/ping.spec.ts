import { expect, test, type Page } from '@playwright/test';

test.use({ viewport: { width: 1440, height: 900 } });

type PingEvent = {
  kind: string;
  seq?: number;
  from?: string;
  ttl?: number;
  sent?: number;
  received?: number;
};

/** The dev handles on `window`, as far as these tests use them. */
type DevWindow = {
  __TRACER_DEV__?: boolean;
  tracer: {
    parseTopology(input: unknown): { ok: true; value: unknown } | { ok: false; error: unknown };
    editorStore: {
      getState(): {
        load(topology: unknown): void;
        updateConfig(update: unknown): unknown;
        topology: { devices: Record<string, { config: Record<string, unknown> }> };
      };
    };
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

const accessPort = { shutdown: false, switchport: { mode: 'access', vlan: 1 } };

function pc(id: string, n: number, address: string, gateway: string) {
  return {
    id,
    kind: 'pc',
    model: 'pc',
    position: { x: n * 200, y: 0 },
    powered: true,
    ports: [{ kind: 'fastEthernet', id: 'FastEthernet0', mac: mac(n) }],
    config: {
      hostname: id.slice(4),
      ipv4: { mode: 'static', address: { address, prefixLength: 24 }, gateway },
    },
  };
}

function switchDevice(id: string, n: number) {
  return {
    id,
    kind: 'switch',
    model: 'switch',
    position: { x: n * 200, y: 0 },
    powered: true,
    ports: [
      { kind: 'fastEthernet', id: 'FastEthernet0/1', mac: mac(n * 16 + 1) },
      { kind: 'gigabitEthernet', id: 'GigabitEthernet0/1', mac: mac(n * 16 + 2) },
    ],
    config: {
      hostname: id.slice(4),
      interfaces: { 'FastEthernet0/1': accessPort, 'GigabitEthernet0/1': accessPort },
      vlans: { 1: { name: 'default' } },
      virtualInterfaces: { Vlan1: { shutdown: true } },
      servicePasswordEncryption: false,
      domainLookup: true,
      unknownLines: [],
    },
  };
}

const link = (id: string, a: [string, string], b: [string, string]) => ({
  id,
  cable: 'straight',
  a: { device: a[0], port: a[1] },
  b: { device: b[0], port: b[1] },
});

/** PC1 - SW1 - R1 - SW2 - PC2, with R1 routing between 192.168.1.0/24 and 192.168.2.0/24. */
const LAB = {
  version: 1,
  meta: {
    name: 'Ping',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  devices: {
    dev_PC1: pc('dev_PC1', 1, '192.168.1.10', '192.168.1.1'),
    dev_SW1: switchDevice('dev_SW1', 2),
    dev_R1: {
      id: 'dev_R1',
      kind: 'router',
      model: 'router',
      position: { x: 600, y: 0 },
      powered: true,
      ports: [
        { kind: 'gigabitEthernet', id: 'GigabitEthernet0/0', mac: mac(0x31) },
        { kind: 'gigabitEthernet', id: 'GigabitEthernet0/1', mac: mac(0x32) },
      ],
      config: {
        hostname: 'R1',
        interfaces: {
          'GigabitEthernet0/0': {
            shutdown: false,
            ipv4: { address: '192.168.1.1', prefixLength: 24 },
          },
          'GigabitEthernet0/1': {
            shutdown: false,
            ipv4: { address: '192.168.2.1', prefixLength: 24 },
          },
        },
        virtualInterfaces: {},
        staticRoutes: [],
        servicePasswordEncryption: false,
        domainLookup: true,
        unknownLines: [],
      },
    },
    dev_SW2: switchDevice('dev_SW2', 4),
    dev_PC2: pc('dev_PC2', 5, '192.168.2.10', '192.168.2.1'),
  },
  links: {
    lnk_1: link('lnk_1', ['dev_PC1', 'FastEthernet0'], ['dev_SW1', 'FastEthernet0/1']),
    lnk_2: link('lnk_2', ['dev_SW1', 'GigabitEthernet0/1'], ['dev_R1', 'GigabitEthernet0/0']),
    lnk_3: link('lnk_3', ['dev_R1', 'GigabitEthernet0/1'], ['dev_SW2', 'GigabitEthernet0/1']),
    lnk_4: link('lnk_4', ['dev_SW2', 'FastEthernet0/1'], ['dev_PC2', 'FastEthernet0']),
  },
  annotations: {},
};

async function openLab(page: Page) {
  await page.addInitScript(() => {
    (window as unknown as DevWindow).__TRACER_DEV__ = true;
  });
  await page.goto('./');
  await expect(page.getByRole('contentinfo').getByRole('status')).toHaveText('Engine ready');
  await page.evaluate((topology) => {
    const { tracer } = window as unknown as DevWindow;
    const parsed = tracer.parseTopology(topology);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.error));
    tracer.editorStore.getState().load(parsed.value);
  }, LAB);
}

const lights = (page: Page, cable: RegExp) =>
  page.getByRole('group', { name: cable }).locator('.link-light');

test('pings PC2 from PC1 across a router through the simulation worker', async ({ page }) => {
  await openLab(page);

  const events = await page.evaluate(
    () =>
      new Promise<PingEvent[]>((resolve, reject) => {
        const events: PingEvent[] = [];
        const options = { count: 4, timeoutMs: 1000 };
        void (window as unknown as DevWindow).tracerSim
          .ping('dev_PC1', '192.168.2.10', options, (event) => {
            events.push(event);
            if (event.kind === 'summary') resolve(events);
          })
          .then((started) => {
            if (!started.ok) reject(new Error(`ping did not start: ${started.error}`));
          });
      }),
  );

  expect(events.slice(0, 4)).toEqual(
    [1, 2, 3, 4].map((seq) =>
      expect.objectContaining({ kind: 'reply', seq, from: '192.168.2.10', ttl: 127 }),
    ),
  );
  expect(events[4]).toMatchObject({ kind: 'summary', sent: 4, received: 4 });
});

test("lights every link green, and shutting a port turns that link's lights red", async ({
  page,
}) => {
  await openLab(page);
  const r1ToSw2 = /^Straight-through cable from R1 Gi0\/1 to SW2 Gi0\/1$/;
  await expect(page.locator('.link-light[data-state="up"]')).toHaveCount(8);

  await page.evaluate(() => {
    const store = (window as unknown as DevWindow).tracer.editorStore.getState();
    const config = store.topology.devices['dev_R1']!.config as {
      interfaces: Record<string, { shutdown: boolean }>;
    };
    const gi01 = { ...config.interfaces['GigabitEthernet0/1']!, shutdown: true };
    store.updateConfig({
      device: 'dev_R1',
      kind: 'router',
      config: { ...config, interfaces: { ...config.interfaces, 'GigabitEthernet0/1': gi01 } },
    });
  });

  await expect(lights(page, r1ToSw2)).toHaveCount(2);
  for (const light of await lights(page, r1ToSw2).all()) {
    await expect(light).toHaveAttribute('data-state', 'down');
  }
  await expect(page.locator('.link-light[data-state="up"]')).toHaveCount(6);
});
