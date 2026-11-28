import { expect, test, type Page } from '@playwright/test';
import { fastForward, gotoCanvas, terminalIn } from './lab';

test.use({ viewport: { width: 1440, height: 900 } });

const device = (page: Page, hostname: string) =>
  page.getByRole('group', { name: new RegExp(`^${hostname},`) });

/** Rows wrap in the narrow inspector, so output is compared with whitespace removed. */
const squeeze = (text: string) => text.replace(/\s+/g, '');

async function openSample(page: Page, title: RegExp, hostnames: readonly string[]) {
  await page.addInitScript(() => {
    (window as unknown as { __TRACER_DEV__?: boolean }).__TRACER_DEV__ = true;
  });
  await gotoCanvas(page);
  await page.keyboard.press('ControlOrMeta+k');
  await page.keyboard.type('open sample');
  await page.keyboard.press('Enter');
  await page
    .getByRole('dialog', { name: 'Sample labs' })
    .getByRole('button', { name: title })
    .click();
  for (const hostname of hostnames) await expect(device(page, hostname)).toBeVisible();
}

test('two lightweight APs join WLC1 over CAPWAP, broadcast its WLAN, and a laptop pings through them', async ({
  page,
}) => {
  await openSample(page, /Wireless LAN controller/, ['R1', 'SW1', 'WLC1', 'LAP1', 'LAP2']);
  // The switch forwards after 4 seconds, then each AP leases, discovers and joins within a few more.
  await fastForward(page, 12);

  await device(page, 'WLC1').locator('.device-tile').dblclick();
  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  await inspector.getByRole('tab', { name: 'Config' }).click();
  const aps = inspector.getByRole('table', { name: 'Access points' });
  await expect(aps).toContainText('LAP1');
  await expect(aps).toContainText('LAP2');
  await expect(aps).toContainText('3702i');
  await expect(inspector.getByRole('list', { name: 'WLANs' })).toContainText('Corp');

  await device(page, 'LAP1').locator('.device-tile').dblclick();
  await inspector.getByRole('tab', { name: 'Config' }).click();
  await expect(inspector).toContainText('WLC1 (192.168.10.2)');

  await device(page, 'Laptop1').locator('.device-tile').dblclick();
  await inspector.getByRole('tab', { name: 'Desktop' }).click();
  await inspector.getByRole('button', { name: /Command Prompt/ }).click();
  const prompt = terminalIn(page, inspector);
  await expect.poll(prompt.lastRow).toBe('C:\\>');
  const output = async () => squeeze((await prompt.rows()).join(''));
  await page.keyboard.type('ping 192.168.10.1');
  await page.keyboard.press('Enter');
  await expect.poll(output, { timeout: 15_000 }).toContain('Sent=4,Received=4,Lost=0');
});

test('a laptop signs in to the Home Gateway’s IoT page and turns the lamp on', async ({ page }) => {
  await openSample(page, /Smart home/, ['HomeGateway', 'Lamp', 'Door', 'Motion', 'Laptop']);
  // The things lease addresses and register within a few seconds.
  await fastForward(page, 8);

  await device(page, 'HomeGateway').locator('.device-tile').dblclick();
  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  await inspector.getByRole('tab', { name: 'Config' }).click();
  const registered = inspector.getByRole('list', { name: 'Registered IoT devices' });
  for (const name of ['Lamp', 'Door', 'Motion']) await expect(registered).toContainText(name);

  await device(page, 'Laptop').locator('.device-tile').dblclick();
  await inspector.getByRole('tab', { name: 'Desktop' }).click();
  await inspector.getByRole('button', { name: /Web Browser/ }).click();
  await inspector.getByRole('textbox', { name: 'URL' }).fill('192.168.25.1');
  await inspector.getByRole('button', { name: 'Go' }).click();

  const frame = inspector.locator('iframe[title="Page"]').contentFrame();
  await frame.getByLabel('Username').fill('admin');
  await frame.getByLabel('Password').fill('admin');
  await frame.getByRole('button', { name: 'Sign In' }).click();
  await expect(frame.getByRole('heading', { name: 'IoT Server - Devices' })).toBeVisible({
    timeout: 15_000,
  });
  // The state a thing is in shows as text; each other state is a link that orders it.
  const lamp = () => frame.getByRole('row', { name: /Lamp/ });
  await expect(lamp().getByRole('link', { name: 'Off' })).toHaveCount(0);
  await lamp().getByRole('link', { name: 'On' }).click();
  await expect(lamp().getByRole('link', { name: 'Off' })).toBeVisible({ timeout: 15_000 });
  await expect(lamp().getByRole('link', { name: 'On' })).toHaveCount(0);

  // The lamp took the order: its own Config tab follows.
  await fastForward(page, 1);
  await device(page, 'Lamp').locator('.device-tile').dblclick();
  await inspector.getByRole('tab', { name: 'Config' }).click();
  await expect(
    inspector.getByRole('radiogroup', { name: 'Status' }).getByRole('radio', { name: 'On' }),
  ).toBeChecked();
});
