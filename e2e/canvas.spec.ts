import { expect, test, type Page } from '@playwright/test';
import { gotoCanvas } from './lab';

test.use({ viewport: { width: 1440, height: 900 } });

const canvas = (page: Page) => page.getByRole('main', { name: 'Canvas' });
const device = (page: Page, hostname: string) =>
  page.getByRole('group', { name: new RegExp(`^${hostname},`) });
const link = (page: Page, label: RegExp) => page.getByRole('group', { name: label });

async function dropDevice(page: Page, name: string, x: number, y: number) {
  await page
    .getByRole('complementary', { name: 'Device palette' })
    .getByText(name, { exact: true })
    .dragTo(canvas(page), { targetPosition: { x, y } });
}

async function choosePort(page: Page, port: string) {
  await page
    .getByRole('option')
    .filter({ has: page.getByText(port, { exact: true }) })
    .click();
}

async function cable(page: Page, from: string, fromPort: string, to: string, toPort: string) {
  await device(page, from).locator('.device-tile').click();
  await choosePort(page, fromPort);
  await device(page, to).locator('.device-tile').click();
  await choosePort(page, toPort);
}

async function routerAndSwitch(page: Page) {
  await gotoCanvas(page);
  await dropDevice(page, 'Branch Router', 220, 180);
  await dropDevice(page, 'Access Switch 24', 520, 420);
}

test('devices dragged from the palette land where they are dropped, with unique names', async ({
  page,
}) => {
  await routerAndSwitch(page);
  await expect(device(page, 'Router0')).toBeVisible();
  await expect(device(page, 'Switch0')).toBeVisible();

  const box = (await canvas(page).boundingBox())!;
  const router = (await device(page, 'Router0').boundingBox())!;
  expect(router.x + router.width / 2 - box.x).toBeCloseTo(220, -1);
  expect(router.y + router.height / 2 - box.y).toBeCloseTo(180, -1);

  await page
    .getByRole('complementary', { name: 'Device palette' })
    .getByText('Branch Router')
    .click();
  await expect(device(page, 'Router1')).toBeVisible();
  await expect(page.getByText('Your lab is empty')).toBeHidden();
});

test('the cable tool connects two picked ports and draws the link with two lights', async ({
  page,
}) => {
  await routerAndSwitch(page);
  await page.keyboard.press('c');
  await expect(page.getByText('Click a device to plug in the first end')).toBeVisible();

  await device(page, 'Router0').locator('.device-tile').click();
  const options = page.getByRole('option');
  await expect(options.first()).toContainText('Gi0/0');
  await expect(page.getByRole('option', { name: /^Se0\/0\/0/ })).toBeVisible();
  await choosePort(page, 'Gi0/0');

  await device(page, 'Switch0').locator('.device-tile').click();
  await choosePort(page, 'Gi0/1');

  const created = link(page, /^Straight-through cable from Router0 Gi0\/0 to Switch0 Gi0\/1$/);
  await expect(created).toBeVisible();
  await expect(created.locator('.link-light')).toHaveCount(2);
  await expect(created.locator('.port-label')).toHaveText(['Gi0/0', 'Gi0/1']);

  await page.keyboard.press('Escape');
  await expect(page.getByText('Click a device to plug in the first end')).toBeHidden();
});

test('a cable from a device to itself is refused with a notice, and Esc drops it', async ({
  page,
}) => {
  await routerAndSwitch(page);
  await page.keyboard.press('c');
  await device(page, 'Router0').locator('.device-tile').click();
  await choosePort(page, 'Gi0/0');
  await device(page, 'Router0').locator('.device-tile').click();

  await expect(page.getByRole('alert')).toContainText('A cable needs two devices');
  await page.keyboard.press('Escape');
  await expect(page.getByText('Click a device to plug in the first end')).toBeVisible();
  await expect(page.getByRole('group', { name: /cable from/ })).toHaveCount(0);
});

test('moving a device is one undo step', async ({ page }) => {
  await routerAndSwitch(page);
  const router = device(page, 'Router0');
  const before = (await router.boundingBox())!;

  await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(
      before.x + before.width / 2 + i * 20,
      before.y + before.height / 2 + i * 10,
    );
  }
  await page.mouse.up();
  const moved = (await router.boundingBox())!;
  expect(moved.x - before.x).toBeGreaterThan(100);
  expect(moved.y - before.y).toBeGreaterThan(40);

  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => (await router.boundingBox())!.x).toBeCloseTo(before.x, 0);
  await expect(device(page, 'Switch0')).toBeVisible();
});

test('deleting a device removes its links, and undo brings both back', async ({ page }) => {
  await routerAndSwitch(page);
  await page.keyboard.press('c');
  await cable(page, 'Router0', 'Gi0/0', 'Switch0', 'Fa0/1');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  const created = link(page, /cable from Router0 Gi0\/0 to Switch0 Fa0\/1/);
  await expect(created).toBeVisible();

  await device(page, 'Switch0').locator('.device-tile').click();
  await page.keyboard.press('Delete');
  await expect(device(page, 'Switch0')).toHaveCount(0);
  await expect(created).toHaveCount(0);

  await page.keyboard.press('ControlOrMeta+z');
  await expect(device(page, 'Switch0')).toBeVisible();
  await expect(created).toBeVisible();
});

test('select all is canvas-only, and Backspace deletes the whole selection', async ({ page }) => {
  await routerAndSwitch(page);
  await page.getByRole('textbox', { name: 'Lab name' }).click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Backspace');
  await expect(device(page, 'Router0')).toBeVisible();

  await canvas(page).click({ position: { x: 40, y: 600 } });
  await page.keyboard.press('ControlOrMeta+a');
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(2);
  await page.keyboard.press('Backspace');
  await expect(page.locator('.react-flow__node')).toHaveCount(0);
});

test('fit view brings every device back into view', async ({ page }) => {
  await routerAndSwitch(page);
  const box = (await canvas(page).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 2400);
  await expect(device(page, 'Router0')).not.toBeInViewport();
  await expect(device(page, 'Switch0')).not.toBeInViewport();

  await page.keyboard.press('1');
  await expect(device(page, 'Router0')).toBeInViewport();
  await expect(device(page, 'Switch0')).toBeInViewport();

  await page.keyboard.press('ControlOrMeta+k');
  await page.keyboard.type('fit view');
  await page.keyboard.press('Enter');
  await expect(device(page, 'Switch0')).toBeInViewport();
});

test('panning and zooming by wheel, keys and Space-drag move the view without errors', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await routerAndSwitch(page);
  const viewport = page.locator('.react-flow__viewport');
  const transform = () => viewport.evaluate((el) => (el as HTMLElement).style.transform);
  const box = (await canvas(page).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);

  let last = await transform();
  const expectMoved = async () => {
    await expect.poll(transform).not.toBe(last);
    last = await transform();
  };

  await page.mouse.wheel(0, 200);
  await expectMoved();
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -300);
  await page.keyboard.up('Control');
  await expectMoved();

  await page.keyboard.down('Space');
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 60, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.up('Space');
  await expectMoved();

  await page.keyboard.press('-');
  await expectMoved();
  await page.keyboard.press('=');
  await expectMoved();

  expect(errors).toEqual([]);
});
