import { expect, test, type Page } from '@playwright/test';
import { fastForward, select, switch24, terminalIn } from './lab';
import { ROUTED_LAB, type DevWindow } from './routed';

test.use({ viewport: { width: 1440, height: 900 } });

const link = (id: string, a: [string, string], b: [string, string]) => ({
  id,
  cable: 'straight',
  a: { device: a[0], port: a[1] },
  b: { device: b[0], port: b[1] },
});

/**
 * Three factory-default switches cabled in a loop. They are created in order, so SW1 has the
 * lowest MAC and wins the root election, and SW3, the highest, blocks its port toward SW2.
 */
const TRIANGLE = {
  version: 1,
  meta: {
    name: 'Spanning tree',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  devices: {
    dev_SW1: switch24('dev_SW1', 'SW1', 300, 0),
    dev_SW2: switch24('dev_SW2', 'SW2', 0, 400),
    dev_SW3: switch24('dev_SW3', 'SW3', 600, 400),
  },
  links: {
    lnk_12: link('lnk_12', ['dev_SW1', 'GigabitEthernet0/1'], ['dev_SW2', 'GigabitEthernet0/1']),
    lnk_13: link('lnk_13', ['dev_SW1', 'GigabitEthernet0/2'], ['dev_SW3', 'GigabitEthernet0/1']),
    lnk_23: link('lnk_23', ['dev_SW2', 'GigabitEthernet0/2'], ['dev_SW3', 'GigabitEthernet0/2']),
  },
  annotations: {},
};

async function openTriangle(page: Page) {
  await page.addInitScript(() => {
    (window as unknown as DevWindow).__TRACER_DEV__ = true;
  });
  await page.goto('./');
  await expect(page.getByRole('contentinfo').getByRole('status')).toHaveText('Engine ready');
  await page.evaluate((topology) => {
    (window as unknown as DevWindow).tracer.loadLab(topology);
  }, TRIANGLE);
}

const lightsOf = (page: Page, cable: RegExp) =>
  page.getByRole('group', { name: cable }).locator('.link-light');

test('a loop of switches blocks one port: its light turns amber and show spanning-tree says BLK', async ({
  page,
}) => {
  await openTriangle(page);

  // Every port listens, then learns, before it forwards: all six ends start amber.
  await expect(page.locator('.link-light[data-state="pending"]')).toHaveCount(6);

  await fastForward(page);

  await expect(page.locator('.link-light[data-state="up"]')).toHaveCount(5);
  await expect(page.locator('.link-light[data-state="pending"]')).toHaveCount(1);
  const sw2ToSw3 = lightsOf(page, /^Straight-through cable from SW2 Gi0\/2 to SW3 Gi0\/2$/);
  await expect(sw2ToSw3.nth(0)).toHaveAttribute('data-state', 'up');
  await expect(sw2ToSw3.nth(1)).toHaveAttribute('data-state', 'pending');

  await select(page, 'dev_SW3');
  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  await inspector.getByRole('tab', { name: 'CLI' }).click();
  const cli = terminalIn(page, inspector);
  await cli.input.focus();
  await expect.poll(cli.lastRow).toBe('SW3>');
  await cli.run('enable', 'SW3#');

  // The inspector is narrower than IOS output, so rows wrap and the echo scrolls out of view:
  // wait for the output with spaces removed. Unit tests pin the column layout.
  await page.keyboard.type('show spanning-tree');
  await page.keyboard.press('Enter');
  const shown = async () => (await cli.rows()).join('').replace(/\s+/g, '');
  await expect
    .poll(shown)
    .toContain(
      [
        'Interface        Role Sts Cost      Prio.Nbr Type',
        '---------------- ---- --- --------- -------- --------------------------------',
        'Gi0/1            Root FWD 4         128.25   P2p',
        'Gi0/2            Altn BLK 4         128.26   P2p',
        'SW3#',
      ]
        .join('')
        .replace(/\s+/g, ''),
    );
});

test('a lab pings within seconds of loading, and Lab settings switches it to the real IOS timers', async ({
  page,
}) => {
  await page.addInitScript(() => {
    (window as unknown as DevWindow).__TRACER_DEV__ = true;
  });
  await page.goto('./');
  await expect(page.getByRole('contentinfo').getByRole('status')).toHaveText('Engine ready');

  // No fast-forward: the clock runs at 1x, and PC1 pings PC2 until a reply comes back.
  const elapsed = await page.evaluate(
    (topology) =>
      new Promise<number>((resolve) => {
        const { tracer, tracerSim } = window as unknown as DevWindow;
        tracer.loadLab(topology);
        const start = performance.now();
        const ping = () =>
          void tracerSim
            .ping('dev_PC1', '192.168.2.10', { count: 1, timeoutMs: 500 }, (event) => {
              if (event.kind === 'reply') resolve(performance.now() - start);
              else if (event.kind === 'summary' && event.received === 0) ping();
            })
            .then((started) => {
              // The worker gets the lab a moment after the editor does.
              if (!started.ok) setTimeout(ping, 100);
            });
        ping();
      }),
    ROUTED_LAB,
  );
  // Each switch port listens for 2 s and learns for 2 s before it forwards.
  expect(elapsed).toBeGreaterThan(3_000);
  expect(elapsed).toBeLessThan(8_000);

  await select(page, 'dev_SW1');
  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  await inspector.getByRole('tab', { name: 'CLI' }).click();
  const cli = terminalIn(page, inspector);
  await cli.input.focus();
  await expect.poll(cli.lastRow).toBe('SW1>');
  await cli.run('enable', 'SW1#');
  const shown = async () => (await cli.rows()).join('').replace(/\s+/g, '');
  const showSpanningTree = async () => {
    await cli.input.focus();
    await page.keyboard.type('show spanning-tree');
    await page.keyboard.press('Enter');
  };
  await showSpanningTree();
  await expect.poll(shown).toContain('HelloTime1secMaxAge7secForwardDelay2sec');

  await page.getByRole('button', { name: 'Tracer menu' }).click();
  await page.getByRole('menuitem', { name: 'Lab settings…' }).click();
  const settings = page.getByRole('dialog', { name: 'Lab settings' });
  await expect(settings.getByRole('radio', { name: 'Fast (default)' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await settings.getByRole('radio', { name: 'Real IOS (30 s)' }).click();
  await expect(settings).toContainText('a new port forwards after 30 s');
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();

  await showSpanningTree();
  await expect.poll(shown).toContain('HelloTime2secMaxAge20secForwardDelay15sec');
});
