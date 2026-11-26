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
    .getByRole('button', { name: /PAT and an access list/ })
    .click();
  for (const hostname of ['R1', 'SW1', 'PC1', 'PC2', 'PC3', 'Server']) {
    await expect(device(page, hostname)).toBeVisible();
  }
}

/** Opens a PC's Command Prompt in the inspector, pings `target`, and returns the output once done. */
async function pingFrom(page: Page, hostname: string, target: string) {
  await device(page, hostname).locator('.device-tile').dblclick();
  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  await inspector.getByRole('button', { name: /Command Prompt/ }).click();
  const prompt = terminalIn(page, inspector);
  await expect.poll(prompt.lastRow).toBe('C:\\>');
  await page.keyboard.type(`ping ${target}`);
  await page.keyboard.press('Enter');
  const output = async () => squeeze((await prompt.rows()).join(''));
  await expect.poll(output, { timeout: 15_000 }).toContain('Sent=4');
  return output();
}

test('the PAT sample: two PCs ping the server through one address on different ports, and the ACL stops PC3', async ({
  page,
}) => {
  await openSample(page);
  // Spanning tree holds SW1's ports for a few seconds before they forward.
  await fastForward(page);

  expect(await pingFrom(page, 'PC1', '203.0.113.10')).toContain('Sent=4,Received=4,Lost=0');
  expect(await pingFrom(page, 'PC2', '203.0.113.10')).toContain('Sent=4,Received=4,Lost=0');
  const denied = await pingFrom(page, 'PC3', '203.0.113.10');
  expect(denied).toContain(squeeze('Reply from 192.168.1.1: Destination host unreachable.'));
  expect(denied).toContain('Received=0');

  await select(page, 'dev_paR1');
  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  await inspector.getByRole('tab', { name: 'CLI' }).click();
  const cli = terminalIn(page, inspector);
  await cli.input.focus();
  await expect.poll(cli.lastRow).toBe('R1>');
  await cli.run('enable', 'R1#');
  const shown = async () => squeeze((await cli.rows()).join(''));

  // Both PCs' pings used echo identifier 1, so PC2's moved to port 1024.
  await page.keyboard.type('show ip nat translations');
  await page.keyboard.press('Enter');
  await expect.poll(shown).toContain(squeeze('icmp 203.0.113.1:1 192.168.1.10:1'));
  await expect.poll(shown).toContain(squeeze('icmp 203.0.113.1:1024 192.168.1.11:1'));

  await page.keyboard.type('show access-lists 110');
  await page.keyboard.press('Enter');
  await expect.poll(shown).toContain(squeeze('10 deny icmp host 192.168.1.12 any (4 matches)'));
});
