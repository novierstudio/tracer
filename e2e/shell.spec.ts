import { expect, test, type Page } from '@playwright/test';

const regions = (page: Page) => ({
  topBar: page.getByRole('banner'),
  rail: page.getByRole('navigation', { name: 'Palette sections' }),
  palette: page.getByRole('complementary', { name: 'Device palette' }),
  canvas: page.getByRole('main', { name: 'Canvas' }),
  inspector: page.getByRole('complementary', { name: 'Inspector' }),
  bottom: page.getByRole('region', { name: 'Bottom panel' }),
  statusBar: page.getByRole('contentinfo'),
});

test.describe('desktop shell', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('renders every region, with the bottom panel hidden until opened', async ({ page }) => {
    await page.goto('./');
    const r = regions(page);

    await expect(page).toHaveTitle('Tracer');
    for (const region of [r.topBar, r.rail, r.palette, r.canvas, r.inspector, r.statusBar]) {
      await expect(region).toBeVisible();
    }
    await expect(r.bottom).toBeHidden();

    await page.getByRole('button', { name: 'Toggle bottom panel' }).click();
    await expect(r.bottom).toBeVisible();
    expect((await r.bottom.boundingBox())!.height).toBeGreaterThan(200);
  });

  test('keeps the Cisco disclaimer one click away', async ({ page }) => {
    await page.goto('./');
    await regions(page)
      .statusBar.getByRole('button', { name: /not affiliated/i })
      .click();
    await expect(page.getByRole('dialog', { name: 'About Tracer' })).toContainText(
      /not affiliated with or endorsed by Cisco/,
    );
  });

  test('collapses panels with their shortcuts and remembers it after reload', async ({ page }) => {
    await page.goto('./');
    const r = regions(page);

    await page.keyboard.press('[');
    await expect(r.palette).toBeHidden();
    await expect(page.getByRole('button', { name: 'Toggle device palette' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    await page.keyboard.press(']');
    await expect(r.inspector).toBeHidden();
    await page.keyboard.press('`');
    await expect(r.bottom).toBeVisible();

    await page.reload();
    await expect(r.canvas).toBeVisible();
    await expect(r.palette).toBeHidden();
    await expect(r.inspector).toBeHidden();
    await expect(r.bottom).toBeVisible();

    await page.keyboard.press('[');
    await expect(r.palette).toBeVisible();
  });

  test('ignores shortcuts while typing in a text field', async ({ page }) => {
    await page.goto('./');
    const name = page.getByRole('textbox', { name: 'Lab name' });
    await name.fill('Lab [1]');
    await expect(name).toHaveValue('Lab [1]');
    await expect(regions(page).palette).toBeVisible();
  });

  test('focus mode hides everything but the canvas', async ({ page }) => {
    await page.goto('./');
    const r = regions(page);

    await page.keyboard.press('f');
    await expect(r.canvas).toBeVisible();
    const box = (await r.canvas.boundingBox())!;
    expect(box).toMatchObject({ x: 0, y: 0, width: 1440, height: 900 });

    await page.keyboard.press('Escape');
    await expect(r.palette).toBeInViewport();
    expect((await r.canvas.boundingBox())!.width).toBeLessThan(1440);
  });

  test('Ctrl+Enter switches to Simulation and opens the bottom panel', async ({ page }) => {
    await page.goto('./');
    await page.keyboard.press('Control+Enter');
    await expect(page.getByRole('radio', { name: 'Simulation' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await expect(regions(page).bottom).toBeVisible();
    await expect(regions(page).statusBar).toContainText('Simulation');
  });
});

test('theme toggle switches the theme and survives a reload', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('./');
  const html = page.locator('html');
  const background = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

  await expect(html).toHaveClass(/\blight\b/);
  const lightBackground = await background();

  await page.getByRole('button', { name: 'Theme' }).click();
  await page.getByRole('menuitemradio', { name: 'Dark' }).click();
  await expect(html).toHaveClass(/\bdark\b/);
  expect(await background()).not.toBe(lightBackground);

  await page.reload();
  await expect(html).toHaveClass(/\bdark\b/);

  await page.getByRole('button', { name: 'Theme' }).click();
  await page.getByRole('menuitemradio', { name: 'System' }).click();
  await expect(html).toHaveClass(/\blight\b/);
});

test('#/dev/ui loads after a hard reload under /tracer/', async ({ page }) => {
  await page.goto('./#/dev/ui');
  await expect(page.getByRole('heading', { name: 'Design system' })).toBeVisible();

  await page.reload();
  expect(new URL(page.url()).pathname).toBe('/tracer/');
  await expect(page.getByRole('heading', { name: 'Design system' })).toBeVisible();
  await expect(page.getByTestId('gallery-light')).toBeVisible();
  await expect(page.getByTestId('gallery-dark')).toBeVisible();

  await page.getByRole('link', { name: 'Back to app' }).click();
  await expect(regions(page).canvas).toBeVisible();
});

test('still works when localStorage throws', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      get() {
        throw new DOMException('Blocked', 'SecurityError');
      },
    });
  });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('./');

  await expect(regions(page).canvas).toBeVisible();
  await page.keyboard.press('[');
  await expect(regions(page).palette).toBeHidden();
  await page.getByRole('button', { name: 'Theme' }).click();
  await page.getByRole('menuitemradio', { name: 'Dark' }).click();
  await expect(page.locator('html')).toHaveClass(/\bdark\b/);
  expect(errors).toEqual([]);
});

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  const horizontalOverflow = (page: Page) =>
    page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );

  test('has no horizontal scroll and opens side panels as drawers', async ({ page }) => {
    await page.goto('./');
    const r = regions(page);

    await expect(r.canvas).toBeVisible();
    await expect(r.palette).toBeHidden();
    expect(await horizontalOverflow(page)).toBe(0);

    await r.rail.getByRole('button', { name: 'Devices' }).click();
    await expect(page.getByRole('dialog', { name: 'Device palette' })).toBeVisible();
    await expect(r.palette).toBeVisible();
    expect(await horizontalOverflow(page)).toBe(0);
    await page.getByRole('button', { name: 'Close' }).click();

    await page.getByRole('button', { name: 'Toggle inspector' }).click();
    await expect(page.getByRole('dialog', { name: 'Inspector' })).toBeVisible();
    expect(await horizontalOverflow(page)).toBe(0);
  });

  test('the design system gallery has no horizontal scroll', async ({ page }) => {
    await page.goto('./#/dev/ui');
    await expect(page.getByRole('heading', { name: 'Design system' })).toBeVisible();
    expect(await horizontalOverflow(page)).toBe(0);
  });
});
