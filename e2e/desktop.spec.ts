import { expect, test, type Page } from '@playwright/test';
import { fastForward, terminalIn } from './lab';

test.use({ viewport: { width: 1440, height: 900 } });

type DevWindow = {
  __TRACER_DEV__?: boolean;
  tracer: {
    editorStore: {
      getState(): {
        load(topology: unknown): void;
        select(selection: { devices: string[]; links: string[] }): void;
        topology: { devices: Record<string, { config: { ipv4?: unknown } } | undefined> };
      };
    };
    loadLab(input: unknown): void;
  };
};

const mac = (n: number) => `02:00:00:00:01:${n.toString(16).padStart(2, '0')}`;

function pc(id: string, hostname: string, x: number, n: number, ipv4: object) {
  return {
    id,
    kind: 'pc',
    model: 'pc',
    position: { x, y: 120 },
    powered: true,
    ports: [{ kind: 'fastEthernet', id: 'FastEthernet0', mac: mac(n) }],
    config: { hostname, ipv4 },
  };
}

const switchPorts = Array.from({ length: 24 }, (_, i) => ({
  kind: 'fastEthernet',
  id: `FastEthernet0/${i + 1}`,
  mac: mac(32 + i),
}));

/** PC0 with no address and PC1 at 192.168.1.11/24, both on SW0. */
const LAB = {
  version: 1,
  meta: {
    name: 'Desktop',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  devices: {
    dev_PC0: pc('dev_PC0', 'PC0', 0, 1, { mode: 'static' }),
    dev_SW0: {
      id: 'dev_SW0',
      kind: 'switch',
      model: 'switch-24',
      position: { x: 200, y: 0 },
      powered: true,
      ports: switchPorts,
      config: {
        hostname: 'SW0',
        interfaces: Object.fromEntries(
          switchPorts.map((port) => [
            port.id,
            { shutdown: false, switchport: { mode: 'access', vlan: 1 } },
          ]),
        ),
        vlans: { 1: { name: 'default' } },
        unknownLines: [],
      },
    },
    dev_PC1: pc('dev_PC1', 'PC1', 400, 2, {
      mode: 'static',
      address: { address: '192.168.1.11', prefixLength: 24 },
    }),
  },
  links: {
    lnk_1: {
      id: 'lnk_1',
      cable: 'straight',
      a: { device: 'dev_PC0', port: 'FastEthernet0' },
      b: { device: 'dev_SW0', port: 'FastEthernet0/1' },
    },
    lnk_2: {
      id: 'lnk_2',
      cable: 'straight',
      a: { device: 'dev_PC1', port: 'FastEthernet0' },
      b: { device: 'dev_SW0', port: 'FastEthernet0/2' },
    },
  },
  annotations: {},
};

async function openLab(page: Page) {
  await page.addInitScript(() => {
    (window as unknown as DevWindow).__TRACER_DEV__ = true;
  });
  await page.goto('./');
  await page.evaluate((topology) => {
    const { tracer } = window as unknown as DevWindow;
    tracer.loadLab(topology);
  }, LAB);
}

const select = (page: Page, device: string) =>
  page.evaluate((id) => {
    (window as unknown as DevWindow).tracer.editorStore
      .getState()
      .select({ devices: [id], links: [] });
  }, device);

test('sets an address in IP Configuration, then pings from the Command Prompt', async ({
  page,
}) => {
  await openLab(page);
  await select(page, 'dev_PC0');
  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  await inspector.getByRole('tab', { name: 'Desktop' }).click();

  await inspector.getByRole('button', { name: /IP Configuration/ }).click();
  await inspector.getByRole('textbox', { name: 'IP address' }).fill('192.168.1.10');
  await inspector.getByRole('textbox', { name: 'Subnet mask' }).fill('255.255.255.0');
  await inspector.getByRole('button', { name: 'Apply' }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as DevWindow).tracer.editorStore.getState().topology.devices['dev_PC0']
            ?.config.ipv4,
      ),
    )
    .toEqual({ mode: 'static', address: { address: '192.168.1.10', prefixLength: 24 } });

  await inspector.getByRole('button', { name: 'Desktop' }).click();
  await expect(inspector.getByRole('region', { name: 'Network' })).toContainText('192.168.1.10/24');
  await inspector.getByRole('button', { name: /Command Prompt/ }).click();

  const prompt = terminalIn(page, inspector);
  await expect.poll(prompt.lastRow).toBe('C:\\>');
  await prompt.run('ipconfig', 'C:\\>');
  expect(await prompt.rows()).toContain('Ethernet adapter FastEthernet0:');

  // The bottom panel shows the same session, wide enough that no line wraps.
  await page.getByRole('button', { name: 'Toggle bottom panel' }).click();
  const panel = page.getByRole('region', { name: 'Bottom panel' });
  await panel.getByRole('tab', { name: 'Terminal' }).click();
  await expect(panel).toContainText('PC0 Command Prompt');
  const wide = terminalIn(page, panel);
  await expect
    .poll(wide.rows)
    .toEqual(
      expect.arrayContaining([
        'C:\\>ipconfig',
        '   IPv4 Address. . . . . . . . . . . : 192.168.1.10',
        '   Subnet Mask . . . . . . . . . . . : 255.255.255.0',
      ]),
    );

  await fastForward(page);
  await wide.input.focus();
  await page.keyboard.type('cls');
  await page.keyboard.press('Enter');
  await expect.poll(wide.rows).toEqual(['C:\\>']);
  await page.keyboard.type('ping 192.168.1.11');
  await page.keyboard.press('Enter');
  // Done when the summary is up and the prompt is back.
  await expect
    .poll(async () => (await wide.rows()).slice(-4))
    .toEqual([
      '    Packets: Sent = 4, Received = 4, Lost = 0 (0% loss),',
      'Approximate round trip times in milli-seconds:',
      expect.stringMatching(/^ {4}Minimum = \d+ms, Maximum = \d+ms, Average = \d+ms$/),
      'C:\\>',
    ]);
  const rows = await wide.rows();
  expect(
    rows.filter((row) => /^Reply from 192\.168\.1\.11: bytes=32 time[<=]\d+ms TTL=128$/.test(row)),
  ).toHaveLength(4);

  // The prompt is PC0's own: it keeps its output while another device is selected.
  await select(page, 'dev_PC1');
  await expect(panel).toContainText('PC1 Command Prompt');
  await expect.poll(wide.rows).not.toContain('Ping statistics for 192.168.1.11:');
  await select(page, 'dev_PC0');
  await expect.poll(wide.rows).toContain('Ping statistics for 192.168.1.11:');
});

test('stops a running ping with Ctrl+C', async ({ page }) => {
  await openLab(page);
  await select(page, 'dev_PC1');
  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  await inspector.getByRole('tab', { name: 'Desktop' }).click();
  await inspector.getByRole('button', { name: /Command Prompt/ }).click();

  const prompt = terminalIn(page, inspector);
  await expect.poll(prompt.lastRow).toBe('C:\\>');
  await page.keyboard.type('ping -n 10 192.168.1.11');
  await page.keyboard.press('Enter');
  await expect
    .poll(async () => (await prompt.rows()).filter((row) => row.startsWith('Reply')).length)
    .toBeGreaterThanOrEqual(2);
  await page.keyboard.press('Control+C');
  await expect.poll(prompt.lastRow).toBe('C:\\>');
  expect(await prompt.rows()).toEqual(expect.arrayContaining(['Control-C', '^C']));
});
