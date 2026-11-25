import { expect, test, type Page } from '@playwright/test';

test.use({ viewport: { width: 1440, height: 900 } });

/** The dev handle `src/features/inspector/devHandle.ts` puts on `window`, as far as these tests use it. */
type DevWindow = {
  __TRACER_DEV__?: boolean;
  tracer: {
    editorStore: {
      getState(): {
        load(topology: unknown): void;
        select(selection: { devices: string[]; links: string[] }): void;
        topology: { devices: Record<string, { config: { hostname: string } } | undefined> };
      };
    };
  };
};

const mac = (n: number) => `02:00:00:00:00:0${n}`;

/** A router cabled to a PC, as a saved `.tracer.json` would hold it. */
const FIXTURE = {
  version: 1,
  meta: {
    name: 'Inspector',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  devices: {
    dev_R1: {
      id: 'dev_R1',
      kind: 'router',
      model: 'router-4g',
      position: { x: 0, y: 0 },
      powered: true,
      ports: [0, 1, 2, 3].map((n) => ({
        kind: 'gigabitEthernet',
        id: `GigabitEthernet0/${n}`,
        mac: mac(n + 1),
      })),
      config: {
        hostname: 'R1',
        interfaces: {
          'GigabitEthernet0/0': {
            shutdown: false,
            ipv4: { address: '192.168.1.1', prefixLength: 24 },
          },
          'GigabitEthernet0/1': { shutdown: true },
          'GigabitEthernet0/2': { shutdown: true },
          'GigabitEthernet0/3': { shutdown: true },
        },
        unknownLines: [],
      },
    },
    dev_PC1: {
      id: 'dev_PC1',
      kind: 'pc',
      model: 'pc',
      position: { x: 200, y: 0 },
      powered: true,
      ports: [{ kind: 'fastEthernet', id: 'FastEthernet0', mac: mac(9) }],
      config: { hostname: 'PC1', ipv4: { mode: 'static' } },
    },
  },
  links: {
    lnk_1: {
      id: 'lnk_1',
      cable: 'straight',
      a: { device: 'dev_R1', port: 'GigabitEthernet0/0' },
      b: { device: 'dev_PC1', port: 'FastEthernet0' },
    },
  },
  annotations: {},
};

async function openWithFixture(page: Page) {
  await page.addInitScript(() => {
    (window as unknown as DevWindow).__TRACER_DEV__ = true;
  });
  await page.goto('./');
  await page.evaluate((topology) => {
    const store = (window as unknown as DevWindow).tracer.editorStore;
    store.getState().load(topology);
    store.getState().select({ devices: ['dev_R1'], links: [] });
  }, FIXTURE);
}

const hostnameInStore = (page: Page) =>
  page.evaluate(() => {
    const { topology } = (window as unknown as DevWindow).tracer.editorStore.getState();
    return topology.devices['dev_R1']?.config.hostname;
  });

test('renames the selected device from the inspector, and undo restores it', async ({ page }) => {
  await openWithFixture(page);
  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  const hostname = inspector.getByRole('textbox', { name: 'Hostname' });

  await expect(hostname).toHaveValue('R1');
  await expect(inspector.getByText('Edge Router').first()).toBeVisible();

  await hostname.fill('9lives');
  await hostname.press('Enter');
  await expect(inspector.getByRole('alert')).toContainText('must start with a letter');
  expect(await hostnameInStore(page)).toBe('R1');

  await hostname.fill('Core-R1');
  await hostname.press('Enter');
  await expect(inspector.getByRole('alert')).toBeHidden();
  expect(await hostnameInStore(page)).toBe('Core-R1');

  // Undo from the top bar, as a user would after leaving the field.
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(hostname).toHaveValue('R1');
  expect(await hostnameInStore(page)).toBe('R1');
});

test('navigates the device tabs with the keyboard', async ({ page }) => {
  await openWithFixture(page);
  const inspector = page.getByRole('complementary', { name: 'Inspector' });

  await inspector.getByRole('tab', { name: 'Overview' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(inspector.getByRole('tab', { name: 'Interfaces' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  const gi0 = inspector
    .getByRole('list', { name: 'Interfaces' })
    .getByRole('listitem', { name: 'Gi0/0' });
  await expect(gi0).toContainText('192.168.1.1/24');
  await expect(gi0).toContainText('PC1');
});
