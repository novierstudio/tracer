import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 1440, height: 900 } });

test('the device palette lists the catalog by category and filters it', async ({ page }) => {
  await page.goto('./');
  const palette = page.getByRole('complementary', { name: 'Device palette' });
  const groups = palette.getByRole('heading', { level: 3 });
  const categories = palette.getByRole('heading', { level: 4 });

  await expect(groups).toHaveText(['Network Devices', 'End Devices', 'Components']);
  await expect(categories).toHaveText([
    'Routers',
    'Switches',
    'Hubs',
    'Wireless Devices',
    'WAN Emulation',
    'End Devices',
    'Home',
    'Components',
  ]);
  await expect(palette.getByRole('list', { name: 'Routers' }).getByRole('listitem')).toHaveText([
    /^1941\s*2× Gi, 2× Serial$/,
    /^2911\s*3× Gi$/,
    /^ISR4331\s*3× Gi$/,
    /^ISR4321\s*2× Gi$/,
    /^2901\s*2× Gi$/,
    /^819HGW\s*4× Fa, 1× Gi, 1× Serial$/,
    /^829\s*5× Gi$/,
    /^Router-PT\s*2× Fa, 2× Serial, 2× Fa fiber$/,
    /^Router-PT-Empty\s*No ports$/,
    /^1841\s*2× Fa$/,
    /^2620XM\s*1× Fa$/,
    /^2621XM\s*2× Fa$/,
    /^2811\s*2× Fa$/,
  ]);
  await expect(palette.getByRole('list', { name: 'Switches' }).getByRole('listitem')).toHaveText([
    /^2960-24TT\s*24× Fa, 2× Gi$/,
    /^2960-48TT\s*48× Fa, 2× Gi$/,
    /^2960-24TT Fiber\s*24× Fa, 2× Gi fiber$/,
    /^3560-24PS\s*24× Fa, 2× Gi$/,
    /^3650-24PS\s*24× Gi, 4× Gi fiber$/,
    /^2950-24\s*24× Fa$/,
    /^2950T-24\s*24× Fa, 2× Gi$/,
    /^IE-2000\s*8× Fa, 2× Gi$/,
    /^Switch-PT\s*4× Fa, 2× Fa fiber$/,
    /^Switch-PT-Empty\s*No ports$/,
    /^Bridge-PT\s*2× Fa$/,
  ]);
  await expect(palette.getByRole('list', { name: 'Hubs' }).getByRole('listitem')).toHaveText([
    /^Hub-PT\s*6× Fa$/,
    /^Repeater-PT\s*2× Fa$/,
  ]);

  await palette.getByRole('searchbox', { name: 'Search devices' }).fill('laptop');
  await expect(groups).toHaveText(['End Devices']);
  await expect(categories).toHaveText(['End Devices']);
  await expect(palette.getByRole('listitem')).toHaveText([/Laptop-PT/]);

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
    .getByText('2960-24TT', { exact: true })
    .dispatchEvent('dragstart', { dataTransfer });
  const payload = await dataTransfer.evaluate((transfer) => ({
    types: [...transfer.types],
    model: transfer.getData('application/x-tracer-device'),
  }));
  expect(payload).toEqual({ types: ['application/x-tracer-device'], model: 'switch-24' });
});
