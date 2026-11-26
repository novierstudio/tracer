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
    .getByRole('button', { name: /EIGRP with a feasible successor/ })
    .click();
  for (const hostname of ['R1', 'R2', 'R3', 'PC1', 'PC2', 'PC3']) {
    await expect(device(page, hostname)).toBeVisible();
  }
}

test('the EIGRP sample converges: R1 has D routes and a feasible successor, and PC1 pings R3’s LAN', async ({
  page,
}) => {
  await openSample(page);
  // Neighbours come up on the first hello, and the tables follow within a second.
  await fastForward(page, 4);

  await select(page, 'dev_efsR1');
  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  await inspector.getByRole('tab', { name: 'CLI' }).click();
  const cli = terminalIn(page, inspector);
  await cli.input.focus();
  await expect.poll(cli.lastRow).toBe('R1>');
  await cli.run('enable', 'R1#');
  const shown = async () => squeeze((await cli.rows()).join(''));

  await page.keyboard.type('show ip eigrp neighbors');
  await page.keyboard.press('Enter');
  await expect.poll(shown).toContain(squeeze('IP-EIGRP neighbors for process 10'));
  await expect.poll(shown).toContain(squeeze('10.0.12.2       Gig0/1'));
  await expect.poll(shown).toContain(squeeze('10.0.13.2       Se0/0/0'));

  await page.keyboard.type('show ip route');
  await page.keyboard.press('Enter');
  await expect.poll(shown).toContain(squeeze('D     192.168.3.0/24 [90/3328] via 10.0.12.2'));
  await expect.poll(shown).toContain(squeeze('D     192.168.2.0/24 [90/3072] via 10.0.12.2'));

  await page.keyboard.type('show ip eigrp topology');
  await page.keyboard.press('Enter');
  await expect.poll(shown).toContain(squeeze('P 192.168.3.0/24, 1 successors, FD is 3328'));
  await expect.poll(shown).toContain(squeeze('via 10.0.13.2 (2170112/2816), Serial0/0/0'));

  await device(page, 'PC1').locator('.device-tile').dblclick();
  await inspector.getByRole('button', { name: /Command Prompt/ }).click();
  const prompt = terminalIn(page, inspector);
  await expect.poll(prompt.lastRow).toBe('C:\\>');
  await page.keyboard.type('ping 192.168.3.10');
  await page.keyboard.press('Enter');
  const output = async () => squeeze((await prompt.rows()).join(''));
  await expect.poll(output, { timeout: 15_000 }).toContain('Sent=4,Received=4,Lost=0');
});
