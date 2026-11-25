import { expect, test, type Page } from '@playwright/test';
import { openLab, select, terminalIn } from './lab';

test.use({ viewport: { width: 1440, height: 900 } });

const bottomTerminal = (page: Page) =>
  terminalIn(page, page.getByRole('region', { name: 'Bottom panel' }));

/** R1's console in the bottom panel's Terminal tab, focused at its first prompt. */
async function openTerminal(page: Page) {
  await openLab(page);
  await select(page, 'dev_R1');
  await page.getByRole('button', { name: 'Toggle bottom panel' }).click();
  await page.getByRole('tab', { name: 'Terminal' }).click();
  const terminal = bottomTerminal(page);
  await expect(terminal.input).toBeFocused();
  await expect.poll(terminal.lastRow).toBe('R1>');
  return terminal;
}

test('configures the selected router from the Terminal tab', async ({ page }) => {
  const terminal = await openTerminal(page);
  await expect(page.getByRole('region', { name: 'Bottom panel' })).toContainText('R1 console');

  await terminal.run('en', 'R1#');
  await terminal.run('conf t', 'R1(config)#');
  await terminal.run('hostname Core', 'Core(config)#');

  await terminal.run('hostnme R2', 'Core(config)#');
  const [command, caret, message] = (await terminal.rows()).slice(-4);
  expect(command).toBe('Core(config)#hostnme R2');
  expect(caret!.indexOf('^')).toBe('Core(config)#hostn'.length);
  expect(message).toBe("% Invalid input detected at '^' marker.");

  await terminal.run('int g0/0', 'Core(config-if)#');
  await terminal.run('ip add 10.0.0.1 255.255.255.0', 'Core(config-if)#');
  await terminal.run('do sh ver', 'Core(config-if)#');
  expect(await terminal.rows()).toContain('Core uptime is 0 minutes');
  await terminal.run('end', 'Core#');
});

test('? answers at once and redraws the partial line', async ({ page }) => {
  const terminal = await openTerminal(page);
  await page.keyboard.type('sh?');
  await expect.poll(terminal.rows).toEqual(['R1>sh?', 'show', 'R1>sh']);
  await page.keyboard.type(' ver');
  await page.keyboard.press('Enter');
  await expect.poll(terminal.rows).toContain('R1 uptime is 0 minutes');
});

test('a pasted config runs line by line', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const terminal = await openTerminal(page);
  await page.evaluate(() =>
    navigator.clipboard.writeText('enable\nconfigure terminal\nhostname Core\nend\n'),
  );
  await page.keyboard.press('ControlOrMeta+V');
  await expect.poll(terminal.lastRow).toBe('Core#');
  expect(await terminal.rows()).toContain('R1(config)#hostname Core');
});

test('shell shortcuts stay quiet while the terminal has focus', async ({ page }) => {
  const terminal = await openTerminal(page);
  await page.keyboard.type('[f?');
  await expect.poll(terminal.rows).toContain('R1>[f');
  await expect(page.getByRole('complementary', { name: 'Device palette' })).toBeVisible();
  await expect(page.getByRole('dialog')).toBeHidden();
});

test('keeps the session when the panel closes and reopens', async ({ page }) => {
  const terminal = await openTerminal(page);
  await terminal.run('enable', 'R1#');
  await page.getByRole('button', { name: 'Hide bottom panel' }).click();
  await page.getByRole('button', { name: 'Toggle bottom panel' }).click();

  await expect(page.getByRole('tab', { name: 'Terminal' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect.poll(terminal.rows).toEqual(['R1>enable', 'R1#']);
  await terminal.input.focus();
  await page.keyboard.press('ArrowUp');
  await expect.poll(terminal.lastRow).toBe('R1#enable');
});

test('Shift+Tab moves focus out of the terminal', async ({ page }) => {
  const terminal = await openTerminal(page);
  await page.keyboard.press('Shift+Tab');
  await expect(terminal.input).not.toBeFocused();
});
