import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { fastForward, select, terminalIn } from './lab';
import type { DevWindow } from './routed';

test.use({ viewport: { width: 1440, height: 900 } });

type StoreWindow = {
  tracer: {
    loadLab(input: unknown): void;
    editorStore: {
      getState(): {
        addLink(spec: unknown): { ok: boolean };
        removeLinks(ids: string[]): void;
      };
    };
  };
};

const sample = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../src/labs/${name}.tracer.json`, import.meta.url), 'utf8'));

async function openSample(page: Page, name: string) {
  await page.addInitScript(() => {
    (window as unknown as DevWindow).__TRACER_DEV__ = true;
  });
  await page.goto('./');
  await expect(page.getByRole('contentinfo').getByRole('status')).toHaveText('Engine ready');
  await page.evaluate((topology) => {
    (window as unknown as StoreWindow).tracer.loadLab(topology);
  }, sample(name));
  await fastForward(page);
}

/** Opens a switch's CLI in the inspector, in privileged EXEC. */
async function cliOf(page: Page, device: string, hostname: string) {
  await select(page, device);
  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  await inspector.getByRole('tab', { name: 'CLI' }).click();
  const cli = terminalIn(page, inspector);
  await cli.input.focus();
  await expect.poll(cli.lastRow).toBe(`${hostname}>`);
  await cli.run('enable', `${hostname}#`);
  // The inspector is narrower than IOS output, so rows wrap: compare with spaces removed.
  const shown = async () => (await cli.rows()).join('').replace(/\s+/g, '');
  return { cli, shown };
}

const squeeze = (lines: string[]) => lines.join('').replace(/\s+/g, '');

const ping = (page: Page, from: string, to: string) =>
  page.evaluate(
    ({ from, to }) =>
      new Promise<number>((resolve) => {
        const { tracerSim } = window as unknown as DevWindow;
        void tracerSim.ping(from, to, { count: 2, timeoutMs: 1000 }, (event) => {
          if (event.kind === 'summary') resolve(event.received ?? 0);
        });
      }),
    { from, to },
  );

test('an EtherChannel shows in show etherchannel summary as Po1(SU) with both members (P)', async ({
  page,
}) => {
  await openSample(page, 'etherchannel');

  // Both uplinks draw as one bundle, and neither blocks.
  const uplinks = page.getByRole('group', { name: /bundled in Po1$/ });
  await expect(uplinks).toHaveCount(2);
  await expect(uplinks.locator('.link-light[data-state="up"]')).toHaveCount(4);

  const { cli, shown } = await cliOf(page, 'dev_eSW1', 'SW1');
  await page.keyboard.type('show etherchannel summary');
  await page.keyboard.press('Enter');
  await expect
    .poll(shown)
    .toContain(
      squeeze([
        'Group  Port-channel  Protocol    Ports',
        '------+-------------+-----------+----------------------------------------------',
        '1      Po1(SU)           LACP   Gig0/1(P) Gig0/2(P) ',
        'SW1#',
      ]),
    );
  await expect.poll(cli.lastRow).toBe('SW1#');
  expect(await ping(page, 'dev_ePC1', '192.168.1.11')).toBe(2);
});

test('a second PC on a secured port err-disables it, and its link goes red', async ({ page }) => {
  await openSample(page, 'port-security');
  // PC1 is the first address Fa0/1 hears, so it becomes the port's sticky address.
  expect(await ping(page, 'dev_psPC1', '192.168.1.11')).toBe(2);

  await page.evaluate(() => {
    const state = (window as unknown as StoreWindow).tracer.editorStore.getState();
    state.removeLinks(['lnk_psPC1SW1']);
    state.addLink({
      cable: 'straight',
      a: { device: 'dev_psIntruder', port: 'FastEthernet0' },
      b: { device: 'dev_psSW1', port: 'FastEthernet0/1' },
    });
  });
  await fastForward(page);
  expect(await ping(page, 'dev_psIntruder', '192.168.1.11')).toBe(0);

  const intruderCable = page.getByRole('group', {
    name: 'Straight-through cable from Intruder Fa0 to SW1 Fa0/1',
  });
  await expect(intruderCable.locator('.link-light[data-state="down"]')).toHaveCount(2);

  const { shown } = await cliOf(page, 'dev_psSW1', 'SW1');
  await page.keyboard.type('show port-security interface fa0/1');
  await page.keyboard.press('Enter');
  await expect
    .poll(shown)
    .toContain(
      squeeze([
        'Port Security              : Enabled',
        'Port Status                : Secure-shutdown',
        'Violation Mode             : Shutdown',
      ]),
    );
  await expect.poll(shown).toContain(squeeze(['Security Violation Count   : 1']));
});
