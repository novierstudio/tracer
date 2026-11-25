import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { strFromU8, unzipSync } from 'fflate';
import { openLab } from './lab';

const hostnames = (page: Page) => page.locator('.react-flow__node .device-hostname');

// A menu item's accessible name ends with its shortcut, such as "Save Ctrl S".
async function menu(page: Page, item: string) {
  await page.getByRole('button', { name: 'Tracer menu' }).click();
  const name = new RegExp(`^${item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( (Ctrl|⇧|⌘)|$)`);
  await page.getByRole('menuitem', { name }).click();
}

async function downloaded(page: Page, start: () => Promise<void>) {
  const downloading = page.waitForEvent('download');
  await start();
  const download = await downloading;
  return { name: download.suggestedFilename(), bytes: await readFile((await download.path())!) };
}

test('a copied share link opens the same lab in a fresh browser', async ({ page, browser }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await openLab(page);
  await expect(hostnames(page)).toHaveText(['R1', 'SW1', 'R2']);

  await page.getByRole('button', { name: 'Copy share link' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Share link copied.' })).toBeVisible();
  const url = await page.evaluate(() => navigator.clipboard.readText());
  expect(url).toMatch(/\/tracer\/#t=[\w-]+$/);

  const fresh = await browser.newContext();
  const other = await fresh.newPage();
  await other.goto(url);
  const offer = other.getByRole('dialog', { name: 'Open “Sessions”?' });
  await expect(offer).toContainText('3 devices and 1 cable');
  await offer.getByRole('button', { name: 'Open lab' }).click();
  await expect(other.getByRole('textbox', { name: 'Lab name' })).toHaveValue('Sessions');
  await expect(hostnames(other)).toHaveText(['R1', 'SW1', 'R2']);
  expect(new URL(other.url()).hash).toBe('');

  // The shared lab is now this browser's lab, so a reload keeps it without asking again.
  await other.reload();
  await expect(hostnames(other)).toHaveText(['R1', 'SW1', 'R2']);
  await expect(other.getByRole('dialog')).toBeHidden();
  await fresh.close();
});

test('explains a share link that was cut off', async ({ page }) => {
  await page.goto('./#t=q1ZKLUvNK8nMS1WyUlAqzi_KS');
  const problem = page.getByRole('alertdialog', { name: "Couldn't open the shared lab" });
  await expect(problem).toContainText('incomplete or damaged');
  await problem.getByRole('button', { name: 'OK' }).click();
  await expect(page.getByRole('textbox', { name: 'Lab name' })).toHaveValue('Untitled lab');
});

test('exports the lab as PNG and SVG pictures named after the lab', async ({ page }) => {
  await openLab(page);

  const png = await downloaded(page, async () => {
    await menu(page, 'Export image…');
    await page
      .getByRole('dialog', { name: 'Export image' })
      .getByRole('button', { name: 'Export' })
      .click();
  });
  expect(png.name).toBe('Sessions.png');
  expect(png.bytes.subarray(1, 4).toString()).toBe('PNG');
  expect(png.bytes.length).toBeGreaterThan(1000);

  const svg = await downloaded(page, async () => {
    await menu(page, 'Export image…');
    const dialog = page.getByRole('dialog', { name: 'Export image' });
    await dialog.getByRole('radio', { name: 'SVG' }).click();
    await dialog.getByRole('radio', { name: 'Transparent' }).click();
    await dialog.getByRole('button', { name: 'Export' }).click();
  });
  expect(svg.name).toBe('Sessions.svg');
  const text = svg.bytes.toString();
  expect(text).toMatch(/^<svg /);
  for (const hostname of ['R1', 'SW1', 'R2']) expect(text).toContain(`>${hostname}</span>`);
});

test("exports every router and switch's running-config as a zip", async ({ page }) => {
  await openLab(page);
  const zip = await downloaded(page, () => menu(page, 'Export running-configs'));
  expect(zip.name).toBe('Sessions configs.zip');
  const files = unzipSync(zip.bytes);
  expect(Object.keys(files)).toEqual(['R1.txt', 'R2.txt', 'SW1.txt']);
  expect(strFromU8(files['R2.txt']!)).toContain('hostname R2\n');
});
