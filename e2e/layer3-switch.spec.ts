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
    .getByRole('button', { name: /Layer 3 switch/ })
    .click();
  for (const hostname of ['MLS1', 'PC1', 'PC2', 'PC3', 'PC4']) {
    await expect(device(page, hostname)).toBeVisible();
  }
}

test('the layer 3 switch sample routes between VLANs: PC1 pings PC3, and MLS1 lists both VLAN subnets as connected', async ({
  page,
}) => {
  await openSample(page);
  // A VLAN interface comes up once spanning tree forwards a port in its VLAN.
  await fastForward(page);

  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  await device(page, 'PC1').locator('.device-tile').dblclick();
  await inspector.getByRole('button', { name: /Command Prompt/ }).click();
  const prompt = terminalIn(page, inspector);
  await expect.poll(prompt.lastRow).toBe('C:\\>');
  const output = async () => squeeze((await prompt.rows()).join(''));

  await page.keyboard.type('ping 192.168.20.10');
  await page.keyboard.press('Enter');
  await expect.poll(output, { timeout: 15_000 }).toContain('Sent=4,Received=4,Lost=0');

  // One hop on the way: MLS1's Vlan10, PC1's gateway.
  await page.keyboard.type('tracert 192.168.20.10');
  await page.keyboard.press('Enter');
  await expect.poll(output, { timeout: 15_000 }).toContain('Tracecomplete.');
  const trace = (await output()).slice((await output()).lastIndexOf('tracert'));
  expect(trace).toMatch(/1.*192\.168\.10\.1.*2.*192\.168\.20\.10/);

  await select(page, 'dev_lsMLS1');
  await inspector.getByRole('tab', { name: 'CLI' }).click();
  const cli = terminalIn(page, inspector);
  await cli.input.focus();
  await expect.poll(cli.lastRow).toBe('MLS1>');
  await cli.run('enable', 'MLS1#');
  const shown = async () => squeeze((await cli.rows()).join(''));

  await page.keyboard.type('show ip route');
  await page.keyboard.press('Enter');
  await expect
    .poll(shown)
    .toContain(squeeze('C       192.168.10.0/24 is directly connected, Vlan10'));
  await expect
    .poll(shown)
    .toContain(squeeze('C       192.168.20.0/24 is directly connected, Vlan20'));
});
