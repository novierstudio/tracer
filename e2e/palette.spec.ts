import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 1440, height: 900 } });

test('the device palette lists the catalog by category and filters it', async ({ page }) => {
  await page.goto('./');
  const palette = page.getByRole('complementary', { name: 'Device palette' });
  const groups = palette.getByRole('heading', { level: 3 });

  await expect(groups).toHaveText([
    'Routers',
    'Switches',
    'Hubs',
    'Wireless devices',
    'End devices',
    'Servers',
  ]);
  await expect(palette.getByRole('list', { name: 'Routers' }).getByRole('listitem')).toHaveText([
    /Branch Router\s*2× Gi, 2× Serial/,
    /Edge Router\s*4× Gi/,
  ]);

  await palette.getByRole('searchbox', { name: 'Search devices' }).fill('laptop');
  await expect(groups).toHaveText(['End devices']);
  await expect(palette.getByRole('listitem')).toHaveText([/Laptop/]);

  await palette.getByRole('searchbox', { name: 'Search devices' }).fill('nothing like this');
  await expect(palette.getByText('No matching devices')).toBeVisible();
});

test('a palette device is keyboard-focusable and drags its model id', async ({ page }) => {
  await page.goto('./');
  const palette = page.getByRole('complementary', { name: 'Device palette' });

  await palette.getByRole('searchbox', { name: 'Search devices' }).focus();
  await page.keyboard.press('Tab');
  const first = palette.getByRole('listitem').first();
  await expect(first).toBeFocused();
  await expect(first).toHaveAttribute('draggable', 'true');

  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await palette
    .getByText('Access Switch 24', { exact: true })
    .dispatchEvent('dragstart', { dataTransfer });
  const payload = await dataTransfer.evaluate((transfer) => ({
    types: [...transfer.types],
    model: transfer.getData('application/x-tracer-device'),
  }));
  expect(payload).toEqual({ types: ['application/x-tracer-device'], model: 'switch-24' });
});
