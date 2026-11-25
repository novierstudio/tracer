import { expect, test, type Page } from '@playwright/test';
import { devicePositions, gotoCanvas, openLab } from './lab';

test.use({ viewport: { width: 1440, height: 900 } });

const canvas = (page: Page) => page.getByRole('main', { name: 'Canvas' });
const device = (page: Page, hostname: string) =>
  page.getByRole('group', { name: new RegExp(`^${hostname},`) });
const tile = (page: Page, hostname: string) => device(page, hostname).locator('.device-tile');
const links = (page: Page) => page.getByRole('group', { name: /cable from/ });
const notes = (page: Page) => page.locator('.react-flow__node-note');

const positions = devicePositions;

async function centreOf(page: Page, hostname: string) {
  const box = (await tile(page, hostname).boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

test('copying a cabled pair and pasting it adds two devices and the link between them', async ({
  page,
}) => {
  await openLab(page);
  await tile(page, 'R1').click();
  await tile(page, 'SW1').click({ modifiers: ['Shift'] });
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(2);

  await page.keyboard.press('ControlOrMeta+c');
  await page.keyboard.press('ControlOrMeta+v');

  await expect(device(page, 'R0')).toBeVisible();
  await expect(device(page, 'SW0')).toBeVisible();
  await expect(links(page)).toHaveCount(2);
  await expect(
    page.getByRole('group', { name: 'Straight-through cable from R0 Gi0/0 to SW0 Gi0/1' }),
  ).toBeVisible();
  // The copies are selected, so a second paste copies the pair again, one step further along.
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(2);

  await page.keyboard.press('ControlOrMeta+z');
  await expect(device(page, 'R0')).toHaveCount(0);
  await expect(links(page)).toHaveCount(1);

  await tile(page, 'R2').click();
  await page.keyboard.press('ControlOrMeta+d');
  await expect(device(page, 'R0')).toBeVisible();
});

test('auto-layout rearranges the lab and one undo puts every device back', async ({ page }) => {
  await openLab(page);
  const before = await positions(page);

  await page.getByRole('toolbar', { name: 'Canvas tools' }).getByLabel('Auto-layout').click();
  await expect.poll(async () => (await positions(page)).SW1!.y).not.toBe(before.SW1!.y);
  // Wait for the slide to settle before undoing it.
  let settled = await positions(page);
  await expect
    .poll(async () => {
      const now = await positions(page);
      const same = JSON.stringify(now) === JSON.stringify(settled);
      settled = now;
      return same;
    })
    .toBe(true);
  // The router sits above the switch it feeds.
  expect(settled.R1!.y).toBeLessThan(settled.SW1!.y);

  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => positions(page)).toEqual(before);
});

test('a note is created with N, edited inline, deleted and brought back with undo', async ({
  page,
}) => {
  await openLab(page);
  const box = (await canvas(page).boundingBox())!;
  await page.mouse.move(box.x + 300, box.y + 520);
  await page.keyboard.press('n');
  // Typed straight away: the note field must already have focus, or P and S would add devices.
  await page.keyboard.type('Uplink to ISP');
  const editor = page.getByRole('textbox', { name: 'Note text' });
  await expect(editor).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(notes(page)).toHaveText('Uplink to ISP');
  await expect(page.locator('.react-flow__node-device')).toHaveCount(3);

  await notes(page).dblclick();
  await expect(editor).toBeFocused();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('Uplink to ISP, Gi0/0');
  await page.keyboard.press('Escape');
  await expect(notes(page)).toHaveText('Uplink to ISP, Gi0/0');

  await notes(page).click();
  await page.keyboard.press('Backspace');
  await expect(notes(page)).toHaveCount(0);

  await page.keyboard.press('ControlOrMeta+z');
  await expect(notes(page)).toHaveText('Uplink to ISP, Gi0/0');
  await page.keyboard.press('ControlOrMeta+z');
  await expect(notes(page)).toHaveText('Uplink to ISP');
});

test('dragging from a device edge to another device cables their first free ports', async ({
  page,
}) => {
  await openLab(page);
  // Nudged first: React Flow must keep the edge handles when the device's node is replaced.
  await tile(page, 'R2').click();
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await positions(page)).R2).toEqual({ x: 416, y: 0 });
  await page.keyboard.press('Shift+ArrowDown');
  await expect.poll(async () => (await positions(page)).R2).toEqual({ x: 416, y: 64 });
  const from = (await tile(page, 'R2').boundingBox())!;
  const to = await centreOf(page, 'SW1');

  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.move(from.x + from.width + 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 10 });
  await page.mouse.up();

  await expect(
    page.getByRole('group', { name: 'Straight-through cable from R2 Gi0/0 to SW1 Fa0/1' }),
  ).toBeVisible();
  // A drag from the middle of a tile still moves the device rather than starting a cable.
  expect(await positions(page)).toMatchObject({ R2: { x: 416, y: 64 } });
});

test('the device context menu deletes the device', async ({ page }) => {
  await openLab(page);
  await tile(page, 'R2').click({ button: 'right' });
  const menu = page.getByRole('menu', { name: 'Canvas menu' });
  await expect(menu.getByRole('menuitem', { name: 'Open CLI' })).toBeVisible();
  await menu.getByRole('menuitem', { name: /Delete device/ }).click();
  await expect(device(page, 'R2')).toHaveCount(0);
  await expect(device(page, 'R1')).toBeVisible();
});

test('R, S and P add a router, switch and PC under the pointer', async ({ page }) => {
  await gotoCanvas(page);
  const box = (await canvas(page).boundingBox())!;
  const spots = {
    Router0: { key: 'r', x: 300, y: 260 },
    Switch0: { key: 's', x: 620, y: 260 },
    PC0: { key: 'p', x: 460, y: 480 },
  };
  for (const [hostname, { key, x, y }] of Object.entries(spots)) {
    await page.mouse.move(box.x + x, box.y + y);
    await page.keyboard.press(key);
    await expect(device(page, hostname)).toBeVisible();
    const centre = await centreOf(page, hostname);
    // Within one grid step, since new devices snap to the 16px grid.
    expect(Math.abs(centre.x - (box.x + x))).toBeLessThanOrEqual(16);
    expect(Math.abs(centre.y - (box.y + y))).toBeLessThanOrEqual(16);
  }
});
