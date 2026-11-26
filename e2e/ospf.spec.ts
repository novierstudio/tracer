import { expect, test, type Page } from '@playwright/test';
import { fastForward, gotoCanvas, select, terminalIn } from './lab';

test.use({ viewport: { width: 1440, height: 900 } });

const device = (page: Page, hostname: string) =>
  page.getByRole('group', { name: new RegExp(`^${hostname},`) });

/** Rows wrap in the narrow inspector, so output is compared with whitespace removed. */
const squeeze = (text: string) => text.replace(/\s+/g, '');

async function openSample(page: Page) {
  await page.addInitScript(() => {
    (window as unknown as { __TRACER_DEV__?: boolean }).__TRACER_DEV__ = true;
  });
  await gotoCanvas(page);
  await page.keyboard.press('ControlOrMeta+k');
  await page.keyboard.type('open sample');
  await page.keyboard.press('Enter');
  await page
    .getByRole('dialog', { name: 'Sample labs' })
    .getByRole('button', { name: /Three routers with OSPF/ })
    .click();
  for (const hostname of ['R1', 'R2', 'R3', 'PC1', 'PC2', 'PC3']) {
    await expect(device(page, hostname)).toBeVisible();
  }
}

test('the OSPF sample converges: R1 has FULL neighbours and O routes, and PC1 pings across all three routers', async ({
  page,
}) => {
  await openSample(page);
  // The Gigabit links wait 8 simulated seconds before they elect a DR, then go FULL.
  await fastForward(page, 12);

  await select(page, 'dev_otrR1');
  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  await inspector.getByRole('tab', { name: 'CLI' }).click();
  const cli = terminalIn(page, inspector);
  await cli.input.focus();
  await expect.poll(cli.lastRow).toBe('R1>');
  await cli.run('enable', 'R1#');
  const shown = async () => squeeze((await cli.rows()).join(''));

  await page.keyboard.type('show ip ospf neighbor');
  await page.keyboard.press('Enter');
  await expect.poll(shown).toContain(squeeze('2.2.2.2           1   FULL/DR'));
  await expect.poll(shown).toContain(squeeze('3.3.3.3           0   FULL/  -'));

  await page.keyboard.type('show ip route');
  await page.keyboard.press('Enter');
  await expect.poll(shown).toContain(squeeze('O     192.168.3.0/24 [110/3] via 10.0.12.2'));
  await expect.poll(shown).toContain(squeeze('O     192.168.2.0/24 [110/2] via 10.0.12.2'));

  await device(page, 'PC1').locator('.device-tile').dblclick();
  await inspector.getByRole('button', { name: /Command Prompt/ }).click();
  const prompt = terminalIn(page, inspector);
  await expect.poll(prompt.lastRow).toBe('C:\\>');
  await page.keyboard.type('tracert 192.168.3.10');
  await page.keyboard.press('Enter');
  const output = async () => squeeze((await prompt.rows()).join(''));
  // Three routers on the way: R1, R2, then R3, which owns the destination's LAN.
  await expect.poll(output, { timeout: 15_000 }).toContain('Tracecomplete.');
  for (const hop of ['192.168.1.1', '10.0.12.2', '10.0.23.2', '192.168.3.10']) {
    expect(await output()).toContain(hop);
  }

  await page.keyboard.type('ping 192.168.3.10');
  await page.keyboard.press('Enter');
  await expect.poll(output, { timeout: 15_000 }).toContain('Sent=4,Received=4,Lost=0');
});
