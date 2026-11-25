import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 1440, height: 900 } });

const palette = (page: import('@playwright/test').Page) =>
  page.getByRole('dialog', { name: 'Command palette' });

test('Ctrl+K opens the palette and "dark" switches the theme', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('./');
  const html = page.locator('html');
  await expect(html).toHaveClass(/\blight\b/);

  await page.keyboard.press('Control+k');
  await expect(palette(page)).toBeVisible();
  await page.keyboard.type('dark');
  await page.keyboard.press('Enter');

  await expect(palette(page)).toBeHidden();
  await expect(html).toHaveClass(/\bdark\b/);
});

test('toggles a panel from the top bar button and returns focus to it', async ({ page }) => {
  await page.goto('./');
  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  const search = page.getByRole('button', { name: 'Command palette' });
  await expect(inspector).toBeVisible();

  await search.click();
  await page.keyboard.type('inspector');
  await page.keyboard.press('Enter');

  await expect(inspector).toBeHidden();
  await expect(page.getByRole('button', { name: 'Toggle inspector' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await expect(search).toBeFocused();

  // The command it just ran comes first next time.
  await page.keyboard.press('Control+k');
  await expect(palette(page).getByRole('group', { name: 'Recent' })).toContainText(
    'Toggle inspector',
  );
  await page.keyboard.press('Escape');
  await expect(palette(page)).toBeHidden();
  await expect(search).toBeFocused();
});

test('shows only the mode switch that applies and runs it', async ({ page }) => {
  await page.goto('./');
  await page.keyboard.press('Control+k');
  await page.keyboard.type('switch to');
  await expect(palette(page).getByRole('option', { name: /Simulation mode/ })).toBeVisible();
  await expect(palette(page).getByRole('option', { name: /Realtime mode/ })).toBeHidden();
  await page.keyboard.press('Enter');

  await expect(page.getByRole('radio', { name: 'Simulation' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(page.getByRole('region', { name: 'Bottom panel' })).toBeVisible();
});

test('Ctrl+K works while typing in a text field and toggles the palette', async ({ page }) => {
  await page.goto('./');
  await page.getByRole('textbox', { name: 'Lab name' }).focus();
  await page.keyboard.press('Control+k');
  await expect(palette(page)).toBeVisible();
  await page.keyboard.press('Control+k');
  await expect(palette(page)).toBeHidden();
});
