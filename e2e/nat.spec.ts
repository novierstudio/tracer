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
    .getByRole('button', { name: /PAT and an access list/ })
    .click();
  for (const hostname of ['R1', 'SW1', 'PC1', 'PC2', 'PC3', 'Server']) {
    await expect(device(page, hostname)).toBeVisible();
  }
}

/** Opens one of a PC's desktop apps in the inspector, leaving whichever app it had open. */
async function openApp(page: Page, hostname: string, app: RegExp) {
  await device(page, hostname).locator('.device-tile').dblclick();
  const inspector = inspectorOf(page);
  // The desktop opens on its app tiles, or on the app the PC had open, with a way back.
  const back = inspector.getByRole('button', { name: 'Desktop', exact: true });
  await expect(inspector.getByRole('list', { name: 'Apps' }).or(back)).toBeVisible();
  if (await back.isVisible()) await back.click();
  await inspector.getByRole('button', { name: app }).click();
  return inspector;
}

/** Pings `target` from a PC's Command Prompt and returns the output once done. */
async function pingFrom(page: Page, hostname: string, target: string) {
  const inspector = await openApp(page, hostname, /Command Prompt/);
  const prompt = terminalIn(page, inspector);
  await expect.poll(prompt.lastRow).toBe('C:\\>');
  await page.keyboard.type(`ping ${target}`);
  await page.keyboard.press('Enter');
  const output = async () => squeeze((await prompt.rows()).join(''));
  await expect.poll(output, { timeout: 15_000 }).toContain('Sent=4');
  return output();
}

/** Loads `url` in a PC's Web Browser and returns the inspector that shows it. */
async function browseFrom(page: Page, hostname: string, url: string) {
  const inspector = await openApp(page, hostname, /Web Browser/);
  await inspector.getByRole('textbox', { name: 'URL' }).fill(url);
  await inspector.getByRole('button', { name: 'Go' }).click();
  return inspector;
}

test('the PAT sample: PCs share one address on different ports, and the ACL keeps PC3 off the web but not off ping', async ({
  page,
}) => {
  // Three pings of 4 s and PC3's blocked page load, which waits out TCP's 5 s, all in realtime.
  test.setTimeout(90_000);
  await openSample(page);
  // Spanning tree holds SW1's ports for a few seconds before they forward.
  await fastForward(page);

  expect(await pingFrom(page, 'PC1', '203.0.113.10')).toContain('Sent=4,Received=4,Lost=0');
  expect(await pingFrom(page, 'PC2', '203.0.113.10')).toContain('Sent=4,Received=4,Lost=0');

  const pc1 = await browseFrom(page, 'PC1', 'http://203.0.113.10');
  const page1 = pc1.locator('iframe[title="Page"]').contentFrame();
  await expect(page1.getByRole('heading', { name: 'You reached 203.0.113.10' })).toBeVisible({
    timeout: 15_000,
  });

  const pc3 = await browseFrom(page, 'PC3', 'http://203.0.113.10');
  await expect(pc3.getByText('Connection timed out')).toBeVisible({ timeout: 15_000 });
  expect(await pingFrom(page, 'PC3', '203.0.113.10')).toContain('Sent=4,Received=4,Lost=0');

  await select(page, 'dev_paR1');
  const inspector = inspectorOf(page);
  await inspector.getByRole('tab', { name: 'CLI' }).click();
  const cli = terminalIn(page, inspector);
  await cli.input.focus();
  await expect.poll(cli.lastRow).toBe('R1>');
  await cli.run('enable', 'R1#');
  const shown = async () => squeeze((await cli.rows()).join(''));

  // PC1's and PC2's pings both used echo identifier 1, so PC2's moved to port 1024.
  await page.keyboard.type('show ip nat translations');
  await page.keyboard.press('Enter');
  await expect.poll(shown).toContain(squeeze('icmp 203.0.113.1:1 192.168.1.10:1'));
  await expect.poll(shown).toContain(squeeze('icmp 203.0.113.1:1024 192.168.1.11:1'));
  await expect.poll(shown).toMatch(/tcp203\.0\.113\.1:\d+192\.168\.1\.10:\d+203\.0\.113\.10:80/);

  await page.keyboard.type('show access-lists 110');
  await page.keyboard.press('Enter');
  await expect.poll(shown).toContain(squeeze('10 deny tcp host 192.168.1.12 any eq www (1 match)'));
});
