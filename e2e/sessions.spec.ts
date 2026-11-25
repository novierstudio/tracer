import { expect, test } from '@playwright/test';
import { hostnameInStore, openLab, select, terminalIn } from './lab';

test.use({ viewport: { width: 1440, height: 900 } });

test('configures R1 from the inspector CLI, undoes it, and keeps its scrollback', async ({
  page,
}) => {
  await openLab(page);
  await select(page, 'dev_R1');
  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  const hostname = inspector.getByRole('textbox', { name: 'Hostname' });
  const cli = terminalIn(page, inspector);

  await inspector.getByRole('tab', { name: 'CLI' }).click();
  await expect(cli.input).toBeFocused();
  await expect.poll(cli.lastRow).toBe('R1>');

  await cli.run('en', 'R1#');
  await cli.run('conf t', 'R1(config)#');
  await cli.run('hostname EDGE', 'EDGE(config)#');
  await expect(hostname).toHaveValue('EDGE');
  await cli.run('end', 'EDGE#');
  expect(await hostnameInStore(page, 'dev_R1')).toBe('EDGE');

  // Ctrl+Z belongs to IOS while the terminal has focus, so leave it first.
  await page.keyboard.press('Shift+Tab');
  await expect(cli.input).not.toBeFocused();
  await page.keyboard.press('ControlOrMeta+z');
  await expect(hostname).toHaveValue('R1');
  expect(await hostnameInStore(page, 'dev_R1')).toBe('R1');

  const transcript = await cli.rows();
  await select(page, 'dev_SW1');
  await expect(hostname).toHaveValue('SW1');
  await expect.poll(cli.rows).toEqual(['SW1>']);

  await select(page, 'dev_R1');
  await expect.poll(cli.rows).toEqual(transcript);
  expect(transcript).toEqual(expect.arrayContaining(['R1>en', 'EDGE(config)#end', 'EDGE#']));
});

test('asks for the console password without echoing it', async ({ page }) => {
  await openLab(page);
  await select(page, 'dev_R2');
  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  const cli = terminalIn(page, inspector);

  await inspector.getByRole('tab', { name: 'CLI' }).click();
  await expect.poll(cli.rows).toEqual(['User Access Verification', 'Password:']);

  await page.keyboard.type('wrong');
  await page.keyboard.press('Enter');
  await expect.poll(cli.rows).toEqual(['User Access Verification', 'Password:', 'Password:']);
  await page.keyboard.type('cisco');
  await page.keyboard.press('Enter');
  await expect.poll(cli.lastRow).toBe('R2>');
  expect((await cli.rows()).join('\n')).not.toMatch(/wrong|cisco/);
});

test('the bottom Terminal tab follows the selected router or switch', async ({ page }) => {
  await openLab(page);
  await page.getByRole('button', { name: 'Toggle bottom panel' }).click();
  const panel = page.getByRole('region', { name: 'Bottom panel' });
  await panel.getByRole('tab', { name: 'Terminal' }).click();
  await expect(panel).toContainText('Select a device');

  await select(page, 'dev_SW1');
  const terminal = terminalIn(page, panel);
  await expect(panel).toContainText('SW1 console');
  await expect.poll(terminal.lastRow).toBe('SW1>');
  await terminal.input.focus();
  await terminal.run('enable', 'SW1#');

  // The inspector's CLI shows the same console, so what one prints the other shows.
  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  await inspector.getByRole('tab', { name: 'CLI' }).click();
  await expect.poll(terminalIn(page, inspector).rows).toEqual(['SW1>enable', 'SW1#']);
});
