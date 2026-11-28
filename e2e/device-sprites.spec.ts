import { expect, test, type Locator, type Page } from '@playwright/test';
import { gotoCanvas } from './lab';

test.use({ viewport: { width: 1440, height: 900 } });

const device = (page: Page, hostname: string) =>
  page.getByRole('group', { name: new RegExp(`^${hostname},`) });

async function openSample(page: Page, title: RegExp) {
  await gotoCanvas(page);
  await page.keyboard.press('ControlOrMeta+k');
  await page.keyboard.type('open sample');
  await page.keyboard.press('Enter');
  await page
    .getByRole('dialog', { name: 'Sample labs' })
    .getByRole('button', { name: title })
    .click();
}

/** The sprite drew: the browser decoded a real image from /devices/. */
async function expectSprite(image: Locator) {
  await image.scrollIntoViewIfNeeded();
  await expect
    .poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth))
    .toBeGreaterThan(0);
  expect(await image.evaluate((element: HTMLImageElement) => element.currentSrc)).toMatch(
    /\/devices\/[a-z0-9-]+(@2x)?\.webp$/,
  );
}

test('canvas devices and palette entries draw their isometric sprites', async ({ page }) => {
  await openSample(page, /Router on a stick/);
  for (const hostname of ['R1', 'SW1', 'PC1']) {
    await expectSprite(device(page, hostname).locator('.device-tile img'));
  }

  const palette = page.getByRole('complementary', { name: 'Device palette' });
  const sprites = palette.getByRole('listitem').locator('img');
  await expect(sprites.first()).toBeAttached();
  for (const image of await sprites.all()) await expectSprite(image);
});

test('a device whose sprite is missing falls back to its glyph', async ({ page }) => {
  await page.route('**/devices/router*.webp', (route) => route.fulfill({ status: 404 }));
  await openSample(page, /Router on a stick/);
  const tile = device(page, 'R1').locator('.device-tile');
  await expect(tile.locator('svg')).toBeVisible();
  await expect(tile.locator('img')).toHaveCount(0);
  await expectSprite(device(page, 'SW1').locator('.device-tile img'));
});
