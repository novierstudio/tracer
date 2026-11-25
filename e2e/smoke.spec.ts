import { expect, test } from '@playwright/test';

test('built app renders under /tracer/', async ({ page }) => {
  await page.goto('./');

  await expect(page).toHaveTitle('Tracer');
  await expect(page.getByRole('heading', { level: 1, name: 'Tracer' })).toBeVisible();
  await expect(page.getByText(/not affiliated with .*Cisco/)).toBeVisible();

  const icon = page.locator('main img');
  await expect(icon).toHaveAttribute('src', /^\/tracer\/assets\//);
  await expect
    .poll(() => icon.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBeGreaterThan(0);
});
