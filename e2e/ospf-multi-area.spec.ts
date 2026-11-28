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
    .getByRole('button', { name: /Multi-area OSPF/ })
    .click();
  for (const hostname of ['R1', 'R2', 'R3', 'ISP', 'PC1', 'PC3']) {
    await expect(device(page, hostname)).toBeVisible();
  }
}

/** Opens a router's CLI in the inspector and enters privileged EXEC. */
async function cliOn(page: Page, id: string, hostname: string) {
  await select(page, id);
  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  await inspector.getByRole('tab', { name: 'CLI' }).click();
  const cli = terminalIn(page, inspector);
  await cli.input.focus();
  await expect.poll(cli.lastRow).toBe(`${hostname}>`);
  await cli.run('enable', `${hostname}#`);
  return async (command: string) => {
    await page.keyboard.type(command);
    await page.keyboard.press('Enter');
    return async () => squeeze((await cli.rows()).join(''));
  };
}

test('the multi-area OSPF sample: R1 learns O IA and O*E2 routes, R3 one summary, and PC1 pings 8.8.8.8 across both areas', async ({
  page,
}) => {
  await openSample(page);
  // Each link waits 8 simulated seconds before it elects a DR, then goes FULL, then the ABR summarizes.
  await fastForward(page, 15);

  const r1 = await cliOn(page, 'dev_omaR1', 'R1');
  const routes = await r1('show ip route');
  await expect.poll(routes).toContain(squeeze('O*E2  0.0.0.0/0 [110/1] via 10.1.12.2'));
  await expect.poll(routes).toContain(squeeze('O IA  192.168.3.0/24 [110/3] via 10.1.12.2'));
  await expect.poll(routes).toContain(squeeze('O E2     203.0.113.0/30 [110/20] via 10.1.12.2'));

  const r3 = await cliOn(page, 'dev_omaR3', 'R3');
  const summarized = await r3('show ip route');
  await expect.poll(summarized).toContain(squeeze('O IA     10.1.0.0/16 [110/2] via 10.0.23.1'));

  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  await device(page, 'PC1').locator('.device-tile').dblclick();
  await inspector.getByRole('button', { name: /Command Prompt/ }).click();
  const prompt = terminalIn(page, inspector);
  await expect.poll(prompt.lastRow).toBe('C:\\>');
  await page.keyboard.type('ping 8.8.8.8');
  await page.keyboard.press('Enter');
  const output = async () => squeeze((await prompt.rows()).join(''));
  await expect.poll(output, { timeout: 15_000 }).toContain('Sent=4,Received=4,Lost=0');
});
