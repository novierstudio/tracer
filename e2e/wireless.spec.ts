import { expect, test, type Locator, type Page } from '@playwright/test';
import { fastForward, gotoCanvas, terminalIn } from './lab';

test.use({ viewport: { width: 1440, height: 900 } });

const device = (page: Page, hostname: string) =>
  page.getByRole('group', { name: new RegExp(`^${hostname},`) });

const linkInfo = (inspector: Locator) =>
  inspector.getByRole('region', { name: 'Link information' }).getByRole('status');

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
    .getByRole('button', { name: /Home wireless network/ })
    .click();
  for (const hostname of ['ISP', 'HomeRouter', 'Laptop1', 'Laptop2', 'PC1', 'Server1']) {
    await expect(device(page, hostname)).toBeVisible();
  }
}

test('Laptop1 joins HomeNet from its PC Wireless app, leases an address and pings past the NAT', async ({
  page,
}) => {
  await openSample(page);
  // HomeRouter leases its Internet address, and Laptop2 its LAN address, within a second.
  await fastForward(page, 2);

  await device(page, 'Laptop1').locator('.device-tile').dblclick();
  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  await inspector.getByRole('button', { name: /PC Wireless/ }).click();
  await expect(linkInfo(inspector)).toHaveText('Not associated with any network.');

  // A wrong key is refused: the radio does not let Laptop1 in.
  await inspector.getByRole('button', { name: /HomeNet/ }).click();
  await inspector.getByLabel('Pre-shared key').fill('wrongkey1');
  await inspector.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(linkInfo(inspector)).toContainText('Not associated');

  await inspector.getByRole('button', { name: /HomeNet/ }).click();
  await inspector.getByLabel('Pre-shared key').fill('tracer123');
  await inspector.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(linkInfo(inspector)).toHaveText('Associated with HomeNet on HomeRouter');
  await fastForward(page, 2);

  await inspector.getByRole('button', { name: 'Desktop' }).click();
  await inspector.getByRole('button', { name: /Command Prompt/ }).click();
  const prompt = terminalIn(page, inspector);
  await expect.poll(prompt.lastRow).toBe('C:\\>');
  const output = async () => squeeze((await prompt.rows()).join(''));
  await page.keyboard.type('ipconfig');
  await page.keyboard.press('Enter');
  await expect.poll(output).toMatch(/IPv4Address(\.)+:192\.168\.0\.10\d/);
  await page.keyboard.type('ping 198.51.100.10');
  await page.keyboard.press('Enter');
  await expect.poll(output, { timeout: 15_000 }).toContain('Sent=4,Received=4,Lost=0');
});
