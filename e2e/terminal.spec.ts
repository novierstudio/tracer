import { expect, test, type Page } from '@playwright/test';

test.use({ viewport: { width: 1440, height: 900 } });

// xterm's screen-reader mode mirrors each visible row into this tree.
const rows = async (page: Page) =>
  (await page.locator('.xterm-accessibility-tree > div').allTextContents())
    .map((row) => row.trimEnd())
    .filter(Boolean);

const lastRow = async (page: Page) => (await rows(page)).at(-1);

const input = (page: Page) => page.locator('.xterm-helper-textarea');

async function openTerminal(page: Page) {
  await page.goto('./');
  await page.getByRole('button', { name: 'Toggle bottom panel' }).click();
  await page.getByRole('tab', { name: 'Terminal' }).click();
  await expect(input(page)).toBeFocused();
  await expect.poll(() => lastRow(page)).toBe('Router>');
}

/** Types a line, presses Enter and waits for its echo and the next prompt. */
async function run(page: Page, line: string, prompt: string) {
  const echo = `${await lastRow(page)}${line}`;
  await page.keyboard.type(line);
  await page.keyboard.press('Enter');
  await expect
    .poll(async () => {
      const shown = await rows(page);
      return shown.includes(echo) && shown.at(-1) === prompt;
    })
    .toBe(true);
}

test('configures the demo router from the Terminal tab', async ({ page }) => {
  await openTerminal(page);
  await expect(page.getByRole('region', { name: 'Bottom panel' })).toContainText(
    'Demo router — devices arrive in a later milestone',
  );

  await run(page, 'en', 'Router#');
  await run(page, 'conf t', 'Router(config)#');
  await run(page, 'hostname R1', 'R1(config)#');

  await run(page, 'hostnme R2', 'R1(config)#');
  const [command, caret, message] = (await rows(page)).slice(-4);
  expect(command).toBe('R1(config)#hostnme R2');
  expect(caret!.indexOf('^')).toBe('R1(config)#hostn'.length);
  expect(message).toBe("% Invalid input detected at '^' marker.");

  await run(page, 'int g0/0', 'R1(config-if)#');
  await run(page, 'ip add 10.0.0.1 255.255.255.0', 'R1(config-if)#');
  await run(page, 'do sh ver', 'R1(config-if)#');
  expect((await rows(page)).slice(-3, -1)).toEqual([
    'Tracer IOS Software, Version 0.1 (demo)',
    'R1 uptime is 0 minutes',
  ]);
  await run(page, 'end', 'R1#');
});

test('? answers at once and redraws the partial line', async ({ page }) => {
  await openTerminal(page);
  await page.keyboard.type('sh?');
  await expect.poll(() => rows(page)).toEqual(['Router>sh?', 'show', 'Router>sh']);
  await page.keyboard.type(' ver');
  await page.keyboard.press('Enter');
  await expect.poll(() => rows(page)).toContain('Tracer IOS Software, Version 0.1 (demo)');
});

test('a pasted config runs line by line', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openTerminal(page);
  await page.evaluate(() =>
    navigator.clipboard.writeText('enable\nconfigure terminal\nhostname Core\nend\n'),
  );
  await page.keyboard.press('ControlOrMeta+V');
  await expect.poll(() => lastRow(page)).toBe('Core#');
  expect(await rows(page)).toContain('Router(config)#hostname Core');
});

test('shell shortcuts stay quiet while the terminal has focus', async ({ page }) => {
  await openTerminal(page);
  await page.keyboard.type('[f?');
  await expect.poll(() => rows(page)).toContain('Router>[f');
  await expect(page.getByRole('complementary', { name: 'Device palette' })).toBeVisible();
  await expect(page.getByRole('dialog')).toBeHidden();
});

test('keeps the session when the panel closes and reopens', async ({ page }) => {
  await openTerminal(page);
  await run(page, 'enable', 'Router#');
  await page.getByRole('button', { name: 'Hide bottom panel' }).click();
  await page.getByRole('button', { name: 'Toggle bottom panel' }).click();

  await expect(page.getByRole('tab', { name: 'Terminal' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect.poll(() => rows(page)).toEqual(['Router>enable', 'Router#']);
  await input(page).focus();
  await page.keyboard.press('ArrowUp');
  await expect.poll(() => lastRow(page)).toBe('Router#enable');
});

test('Shift+Tab moves focus out of the terminal', async ({ page }) => {
  await openTerminal(page);
  await page.keyboard.press('Shift+Tab');
  await expect(input(page)).not.toBeFocused();
});
