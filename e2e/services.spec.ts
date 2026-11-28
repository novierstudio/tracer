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
    .getByRole('button', { name: /Server services/ })
    .click();
  for (const hostname of ['R1', 'SW1', 'PC1', 'PC2', 'Server1']) {
    await expect(device(page, hostname)).toBeVisible();
  }
  // The switch holds its ports for 4 simulated seconds before it forwards.
  await fastForward(page, 5);
}

test('R1 backs its running-config up to Server1 over TFTP, and R1-confg shows in Server1’s TFTP list', async ({
  page,
}) => {
  await openSample(page);
  const inspector = page.getByRole('complementary', { name: 'Inspector' });

  await select(page, 'dev_ssR1');
  await inspector.getByRole('tab', { name: 'CLI' }).click();
  const cli = terminalIn(page, inspector);
  await cli.input.focus();
  await expect.poll(cli.lastRow).toBe('R1>');
  await cli.run('enable', 'R1#');
  const shown = async () => squeeze((await cli.rows()).join(''));

  await page.keyboard.type('copy running-config tftp:');
  await page.keyboard.press('Enter');
  await expect.poll(shown).toMatch(/Addressornameofremotehost\[\]\?$/);
  await page.keyboard.type('192.168.1.20');
  await page.keyboard.press('Enter');
  await expect.poll(shown).toMatch(/Destinationfilename\[R1-confg\]\?$/);
  await page.keyboard.press('Enter');
  // One ! for each 512-byte TFTP block.
  await expect
    .poll(shown, { timeout: 15_000 })
    .toMatch(/Writingrunning-config\.\.\.!+\[OK-\d+bytes\]\d+bytescopiedin/);

  await select(page, 'dev_ssServer1');
  await inspector.getByRole('tab', { name: 'Services' }).dispatchEvent('mousedown');
  const files = inspector.getByTestId('tftp-files');
  await expect(files).toContainText('c2960-lanbasek9-mz.150-2.SE4.bin');
  await expect(files).toContainText('R1-confg');
});

test('PC1 mails user2 through Server1, and PC2 receives it in its inbox', async ({ page }) => {
  await openSample(page);
  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  const status = inspector.getByTestId('email-status');

  await select(page, 'dev_ssPC1');
  await inspector.getByRole('tab', { name: 'Desktop' }).click();
  await inspector.getByRole('button', { name: /Email/ }).click();
  await inspector.getByTestId('email-compose-tab').click();
  await inspector.getByTestId('email-to').fill('user2@lab.local');
  await inspector.getByTestId('email-subject').fill('Lab notes');
  await inspector.getByTestId('email-body').fill('The backup is on Server1.');
  await inspector.getByTestId('email-send').click();
  await expect(status).toHaveText('Send Success.', { timeout: 15_000 });

  await select(page, 'dev_ssPC2');
  await inspector.getByRole('tab', { name: 'Desktop' }).click();
  await inspector.getByRole('button', { name: /Email/ }).click();
  await inspector.getByTestId('email-receive').click();
  await expect(status).toHaveText('Receive Mail Success.', { timeout: 15_000 });
  const row = inspector.getByTestId('email-inbox-row');
  await expect(row).toContainText('Lab notes');
  await expect(row).toContainText('user1@lab.local');
});
