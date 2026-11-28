import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';

// Chromium has the File System Access API; remove it so these tests drive the download and file
// input paths that every other browser uses.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    delete w.showSaveFilePicker;
    delete w.showOpenFilePicker;
  });
  await page.goto('./');
});

const labName = (page: Page) => page.getByRole('textbox', { name: 'Lab name' });
const saveStatus = (page: Page) => page.getByTitle(/Changes autosave/);

async function rename(page: Page, name: string) {
  await labName(page).fill(name);
  await labName(page).press('Enter');
}

// A menu item's accessible name ends with its shortcut, such as "Save Ctrl S".
async function menu(page: Page, item: string) {
  await page.getByRole('button', { name: 'Tracer menu' }).click();
  const name = new RegExp(`^${item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( (Ctrl|⇧|⌘)|$)`);
  await page.getByRole('menuitem', { name }).click();
}

test('restores the lab after a reload', async ({ page }) => {
  await expect(labName(page)).toHaveValue('Untitled lab');
  await rename(page, 'Campus lab');
  await expect(saveStatus(page)).toHaveText('Saving…');
  await expect(saveStatus(page)).toHaveText('Saved');

  await page.reload();
  await expect(labName(page)).toHaveValue('Campus lab');
});

test('asks the browser once to keep its storage, after the first save', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { persistCalls: number };
    w.persistCalls = 0;
    navigator.storage.persisted = async () => false;
    navigator.storage.persist = async () => {
      w.persistCalls += 1;
      return true;
    };
  });
  await page.reload();
  const persistCalls = () =>
    page.evaluate(() => (window as unknown as { persistCalls: number }).persistCalls);
  expect(await persistCalls()).toBe(0);

  await rename(page, 'Campus lab');
  await expect(saveStatus(page)).toHaveText('Saved');
  await expect.poll(persistCalls).toBe(1);

  await rename(page, 'Campus lab 2');
  await expect(saveStatus(page)).toHaveText('Saved');
  expect(await persistCalls()).toBe(1);
});

test('saves a .tracer.json download and opens it back', async ({ page }) => {
  await rename(page, 'Branch lab');

  const downloading = page.waitForEvent('download');
  await menu(page, 'Save');
  const download = await downloading;
  expect(download.suggestedFilename()).toBe('Branch lab.tracer.json');
  const text = await readFile((await download.path())!, 'utf8');
  const saved = JSON.parse(text);
  expect(saved).toMatchObject({ version: 2, meta: { name: 'Branch lab' } });

  await rename(page, 'Something else');
  await menu(page, 'New lab');
  await page
    .getByRole('dialog', { name: 'Start a new lab?' })
    .getByRole('button', { name: 'New lab' })
    .click();
  await expect(labName(page)).toHaveValue('Untitled lab');

  const choosing = page.waitForEvent('filechooser');
  await menu(page, 'Open…');
  const chooser = await choosing;
  await chooser.setFiles({
    name: 'Branch lab.tracer.json',
    mimeType: 'application/json',
    buffer: Buffer.from(text),
  });
  await expect(labName(page)).toHaveValue('Branch lab');

  await page.getByRole('button', { name: 'Tracer menu' }).click();
  await expect(page.getByRole('menuitem', { name: /Something else/ })).toBeVisible();
});

test('asks before New lab discards changes, and Cancel keeps them', async ({ page }) => {
  await menu(page, 'New lab');
  await expect(page.getByRole('dialog')).toBeHidden();

  await rename(page, 'Work in progress');
  await menu(page, 'New lab');
  const dialog = page.getByRole('dialog', { name: 'Start a new lab?' });
  await expect(dialog).toContainText('Work in progress');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await expect(labName(page)).toHaveValue('Work in progress');
});

test('explains why an invalid file cannot be opened', async ({ page }) => {
  const choosing = page.waitForEvent('filechooser');
  await page.keyboard.press('ControlOrMeta+o');
  await (
    await choosing
  ).setFiles({
    name: 'broken.tracer.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{"version": 1, "meta": {}}'),
  });
  const dialog = page.getByRole('alertdialog', { name: "Couldn't open broken.tracer.json" });
  await expect(dialog).toContainText('meta');
  await dialog.getByRole('button', { name: 'OK' }).click();
  await expect(labName(page)).toHaveValue('Untitled lab');
});

test('opens a .tracer.json dropped on the window', async ({ page }) => {
  await page.evaluate(() => {
    const topology = {
      version: 1,
      meta: {
        name: 'Dropped lab',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      devices: {},
      links: {},
      annotations: {},
    };
    const data = new DataTransfer();
    data.items.add(new File([JSON.stringify(topology)], 'dropped.tracer.json'));
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: data, cancelable: true }));
  });
  await expect(labName(page)).toHaveValue('Dropped lab');
});

test('saves in place through the File System Access API', async ({ page }) => {
  // Stand in for the native picker with a real handle from the origin-private file system.
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown> & { pickerCalls: number };
    w.pickerCalls = 0;
    w.showSaveFilePicker = async () => {
      w.pickerCalls += 1;
      const dir = await navigator.storage.getDirectory();
      return dir.getFileHandle('lab.tracer.json', { create: true });
    };
  });
  await page.reload();
  const savedName = () =>
    page.evaluate(async () => {
      const dir = await navigator.storage.getDirectory();
      // The file is missing until the picker runs, then empty until the app's write lands.
      const handle = await dir.getFileHandle('lab.tracer.json').catch(() => undefined);
      // Reading while the app swaps in a new version throws; the poll then tries again.
      const text = await handle
        ?.getFile()
        .then((file) => file.text())
        .catch(() => undefined);
      return text ? (JSON.parse(text).meta.name as string) : undefined;
    });
  const pickerCalls = () =>
    page.evaluate(() => (window as unknown as { pickerCalls: number }).pickerCalls);

  await rename(page, 'In place');
  await page.keyboard.press('ControlOrMeta+s');
  await expect.poll(savedName).toBe('In place');

  // Saving from inside the name field writes to the same file without asking again.
  await labName(page).fill('In place, again');
  await page.keyboard.press('ControlOrMeta+s');
  await expect.poll(savedName).toBe('In place, again');
  expect(await pickerCalls()).toBe(1);
});
