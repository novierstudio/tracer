import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { devicePositions, openLab } from './lab';

test.use({ viewport: { width: 1440, height: 900 } });

type Annotation = {
  id: string;
  kind: string;
  position: { x: number; y: number };
  size?: { width: number; height: number };
  label?: string;
  text?: string;
  shape?: string;
  color: string;
};

const tile = (page: Page, hostname: string) =>
  page.getByRole('group', { name: new RegExp(`^${hostname},`) }).locator('.device-tile');
const areas = (page: Page) => page.locator('.react-flow__node-area');

const annotations = (page: Page) =>
  page.evaluate(() => {
    const { tracer } = window as unknown as {
      tracer: { editorStore: { getState(): { topology: { annotations: object } } } };
    };
    return Object.values(tracer.editorStore.getState().topology.annotations) as Annotation[];
  });

async function centreOf(page: Page, hostname: string) {
  const box = (await tile(page, hostname).boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await page.mouse.up();
}

// A menu item's accessible name ends with its shortcut, such as "Save Ctrl S".
async function menu(page: Page, item: string) {
  await page.getByRole('button', { name: 'Tracer menu' }).click();
  await page.getByRole('menuitem', { name: new RegExp(`^${item}( (Ctrl|⇧|⌘)|$)`) }).click();
}

test('an area box drawn behind two devices survives edits, undo and a save and reopen', async ({
  page,
}) => {
  // Save and Open take the download and file input paths, as in files.spec.ts.
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    delete w.showSaveFilePicker;
    delete w.showOpenFilePicker;
  });
  await openLab(page);
  const r1 = await centreOf(page, 'R1');
  const sw1 = await centreOf(page, 'SW1');

  // B arms the area tool; a drag around R1 and SW1 draws the box and opens its label.
  await page.mouse.click(r1.x, r1.y - 140);
  await page.keyboard.press('b');
  await drag(page, { x: r1.x - 64, y: r1.y - 64 }, { x: sw1.x + 64, y: sw1.y + 80 });
  const label = page.getByRole('textbox', { name: 'Area label' });
  await expect(label).toBeFocused();
  await page.keyboard.type('Building A');
  await page.keyboard.press('Enter');
  await expect(areas(page)).toHaveText('Building A');
  // Behind links (z 0) and devices.
  await expect(areas(page)).toHaveCSS('z-index', '-1');

  // The inspector shows the selected area; a swatch recolours it.
  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  await expect(inspector.getByRole('heading', { name: 'Area box' })).toBeVisible();
  await inspector.getByRole('radio', { name: 'Teal' }).click();
  await expect.poll(async () => (await annotations(page))[0]?.color).toBe('teal');

  // The bottom-right handle makes it bigger.
  const drawn = (await annotations(page))[0]!;
  const handle = areas(page).locator('.react-flow__resize-control.handle.bottom.right');
  const grip = (await handle.boundingBox())!;
  await drag(
    page,
    { x: grip.x + grip.width / 2, y: grip.y + grip.height / 2 },
    { x: grip.x + 100, y: grip.y + 60 },
  );
  await expect
    .poll(async () => (await annotations(page))[0]?.size?.width)
    .toBeGreaterThan(drawn.size!.width);
  const resized = (await annotations(page))[0]!;
  expect(resized.position).toEqual(drawn.position);

  // Dragging R1 around inside the box leaves the box where it is.
  const before = await devicePositions(page);
  await drag(page, r1, { x: r1.x + 32, y: r1.y + 48 });
  await expect.poll(async () => (await devicePositions(page)).R1).not.toEqual(before.R1);
  expect((await annotations(page))[0]).toEqual(resized);

  // T types a text label under the pointer; O then a click places an ellipse.
  const free = { x: sw1.x + 260, y: sw1.y - 140 };
  await page.mouse.move(free.x, free.y);
  await page.keyboard.press('t');
  await expect(page.getByRole('textbox', { name: 'Text' })).toBeFocused();
  await page.keyboard.type('Core');
  await page.keyboard.press('Escape');
  await expect(page.locator('.react-flow__node-text')).toHaveText('Core');
  await page.keyboard.press('o');
  await page.mouse.click(free.x, free.y + 200);
  await expect(page.locator('.react-flow__node-shape')).toHaveCount(1);
  expect((await annotations(page)).map((a) => a.kind).sort()).toEqual(['area', 'shape', 'text']);

  // Three undos take back the ellipse, the text and the drag, and nothing before them.
  for (let i = 0; i < 3; i++) await page.keyboard.press('ControlOrMeta+z');
  await expect(page.locator('.react-flow__node-shape')).toHaveCount(0);
  await expect(page.locator('.react-flow__node-text')).toHaveCount(0);
  await expect.poll(async () => (await devicePositions(page)).R1).toEqual(before.R1);
  expect(await annotations(page)).toEqual([resized]);

  // Save, start afresh and open the file: the area is back as it was.
  const downloading = page.waitForEvent('download');
  await menu(page, 'Save');
  const text = await readFile((await (await downloading).path())!, 'utf8');
  expect(Object.values(JSON.parse(text).annotations)).toEqual([resized]);

  // Just saved, so New lab has nothing to confirm.
  await menu(page, 'New lab');
  await expect(areas(page)).toHaveCount(0);

  const choosing = page.waitForEvent('filechooser');
  await menu(page, 'Open…');
  await (
    await choosing
  ).setFiles({
    name: 'Sessions.tracer.json',
    mimeType: 'application/json',
    buffer: Buffer.from(text),
  });
  await expect(areas(page)).toHaveText('Building A');
  expect(await annotations(page)).toEqual([resized]);
});

test('a box selection inside an area picks the devices, not the area', async ({ page }) => {
  await openLab(page);
  const r1 = await centreOf(page, 'R1');
  const sw1 = await centreOf(page, 'SW1');
  await page.mouse.click(r1.x, r1.y - 140);
  await page.keyboard.press('b');
  await drag(page, { x: r1.x - 96, y: r1.y - 96 }, { x: sw1.x + 96, y: sw1.y + 112 });
  await page.keyboard.press('Enter');

  await drag(page, { x: r1.x - 40, y: r1.y - 40 }, { x: sw1.x + 40, y: sw1.y + 56 });

  await expect(page.locator('.react-flow__node-device.selected')).toHaveCount(2);
  await expect(page.locator('.react-flow__node-area.selected')).toHaveCount(0);
});
