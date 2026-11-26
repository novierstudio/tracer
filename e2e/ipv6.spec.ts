import { expect, test, type Page } from '@playwright/test';
import { fastForward, gotoCanvas, select, terminalIn } from './lab';

test.use({ viewport: { width: 1440, height: 900 } });

const device = (page: Page, hostname: string) =>
  page.getByRole('group', { name: new RegExp(`^${hostname},`) });

/** Rows wrap in the narrow inspector, so output is compared with whitespace removed. */
const squeeze = (text: string) => text.replace(/\s+/g, '');

const inspectorOf = (page: Page) => page.getByRole('complementary', { name: 'Inspector' });

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
    .getByRole('button', { name: /IPv6 with SLAAC/ })
    .click();
  for (const hostname of ['R1', 'SW1', 'SW2', 'PC1', 'PC2', 'PC3', 'PC4']) {
    await expect(device(page, hostname)).toBeVisible();
  }
}

/** Opens a PC's Command Prompt in the inspector, from whichever app it had open. */
async function promptOf(page: Page, hostname: string) {
  await device(page, hostname).locator('.device-tile').dblclick();
  const inspector = inspectorOf(page);
  const back = inspector.getByRole('button', { name: 'Desktop', exact: true });
  await expect(inspector.getByRole('list', { name: 'Apps' }).or(back)).toBeVisible();
  if (await back.isVisible()) await back.click();
  await inspector.getByRole('button', { name: /Command Prompt/ }).click();
  const prompt = terminalIn(page, inspector);
  await expect.poll(prompt.lastRow).toBe('C:\\>');
  return { prompt, output: async () => squeeze((await prompt.rows()).join('')) };
}

test('IPv6 with SLAAC: PCs on automatic form addresses from R1’s prefixes and ping across the router', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await openSample(page);
  // Spanning tree holds the switch ports for 4 s; the PCs' next router solicitation then gets an
  // advertisement back.
  await fastForward(page, 12);

  const pc3 = await promptOf(page, 'PC3');
  await page.keyboard.type('ipv6config');
  await page.keyboard.press('Enter');
  await expect.poll(pc3.output).toMatch(/IPv6Address(?:\.)*:2001:DB8:2:[0-9A-F:]+\/64/);
  const formed = /IPv6Address(?:\.)*:(2001:DB8:2:[0-9A-F:]+)\/64/.exec(await pc3.output())![1]!;
  expect(await pc3.output()).toMatch(/DefaultGateway\.*:FE80::1/);

  const pc1 = await promptOf(page, 'PC1');
  await page.keyboard.type(`ping ${formed.toLowerCase()}`);
  await page.keyboard.press('Enter');
  await expect.poll(pc1.output, { timeout: 20_000 }).toContain('Sent=4');
  const pinged = await pc1.output();
  expect(pinged).toContain(`Replyfrom${formed}:bytes=32`);
  expect(pinged).toContain('Sent=4,Received=4,Lost=0');

  await select(page, 'dev_isR1');
  const inspector = inspectorOf(page);
  await inspector.getByRole('tab', { name: 'CLI' }).click();
  const cli = terminalIn(page, inspector);
  await cli.input.focus();
  await expect.poll(cli.lastRow).toBe('R1>');
  const shown = async () => squeeze((await cli.rows()).join(''));
  await page.keyboard.type('show ipv6 route');
  await page.keyboard.press('Enter');
  await expect.poll(shown).toContain(squeeze('C   2001:DB8:2::/64 [0/0]'));
  await page.keyboard.type('show ipv6 neighbors');
  await page.keyboard.press('Enter');
  await expect.poll(shown).toContain(formed);
});
