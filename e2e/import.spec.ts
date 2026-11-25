import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

const VTP_FIXTURE = fileURLToPath(
  new URL('../src/importers/pkt/__fixtures__/pt8.2-vtp-lab.pkt', import.meta.url),
);

type TestWindow = {
  __TRACER_DEV__?: boolean;
  /** Every import stage the progress dialog showed, in order. */
  importStages: string[];
  tracer: {
    editorStore: {
      getState(): {
        topology: {
          meta: { name: string };
          devices: Record<string, { kind: string; config: { hostname: string } }>;
        };
      };
    };
  };
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as TestWindow & Record<string, unknown>;
    // Drive the file input path that every browser has.
    delete w.showOpenFilePicker;
    w.__TRACER_DEV__ = true;
    // The progress dialog can be gone before a poll sees it, so record it as it renders.
    w.importStages = [];
    new MutationObserver(() => {
      const bar = document.querySelector('[role="progressbar"][aria-label="Import progress"]');
      const stage = bar?.getAttribute('aria-valuetext');
      if (stage && w.importStages.at(-1) !== stage) w.importStages.push(stage);
    }).observe(document, { subtree: true, childList: true, attributes: true });
  });
  await page.goto('./');
});

async function openFile(page: Page, file: string | { name: string; buffer: Buffer }) {
  const choosing = page.waitForEvent('filechooser');
  await page.keyboard.press('ControlOrMeta+o');
  const chooser = await choosing;
  await chooser.setFiles(
    typeof file === 'string' ? file : { ...file, mimeType: 'application/octet-stream' },
  );
}

const stat = (page: Page, label: string) =>
  page.getByRole('dialog').locator('div', { has: page.locator('dt', { hasText: label }) });

test('imports a Packet Tracer file in a worker, after showing its report', async ({ page }) => {
  const workers: string[] = [];
  page.on('worker', (worker) => workers.push(worker.url()));

  await openFile(page, VTP_FIXTURE);
  const report = page.getByRole('dialog', { name: 'Import pt8.2-vtp-lab.pkt' });
  await expect(report).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as TestWindow).importStages)).toContain(
    'Reading the file',
  );
  expect(workers.some((url) => url.includes('import.worker'))).toBe(true);

  await expect(report).toHaveAccessibleDescription(/Packet Tracer 8\.2\.2\.0400/);
  await expect(stat(page, 'Devices')).toHaveText('Devices31 skipped');
  await expect(stat(page, 'Links')).toHaveText('Links20 dropped');
  // Each switch's spanning-tree mode and extend system-id lines are understood, not kept.
  await expect(stat(page, 'Config lines')).toHaveText('Config lines6kept as-is');
  await report.getByText('Skipped devices').click();
  await expect(
    report.getByText('Power Distribution Device: Power Distribution Device0'),
  ).toBeVisible();

  await report.getByRole('button', { name: 'Open lab' }).click();
  await expect(report).toBeHidden();
  await expect(page.getByRole('textbox', { name: 'Lab name' })).toHaveValue('pt8.2-vtp-lab');
  await expect(page.getByRole('contentinfo')).toContainText('3 devices · 2 links');
  const devices = await page.evaluate(() =>
    Object.values(
      (window as unknown as TestWindow).tracer.editorStore.getState().topology.devices,
    ).map((d) => d.kind),
  );
  expect(devices).toEqual(['switch', 'switch', 'switch']);
});

test('Cancel on the report keeps the current lab', async ({ page }) => {
  await openFile(page, VTP_FIXTURE);
  const report = page.getByRole('dialog', { name: 'Import pt8.2-vtp-lab.pkt' });
  await report.getByRole('button', { name: 'Cancel' }).click();
  await expect(report).toBeHidden();
  await expect(page.getByRole('textbox', { name: 'Lab name' })).toHaveValue('Untitled lab');
  await expect(page.getByRole('contentinfo')).toContainText('Empty lab');
});

test('explains that a garbage file is not a Packet Tracer file', async ({ page }) => {
  await openFile(page, { name: 'garbage.pkt', buffer: Buffer.alloc(4096, 0x5a) });
  const dialog = page.getByRole('alertdialog', { name: 'Not a Packet Tracer file' });
  await expect(dialog).toContainText('garbage.pkt');
  await dialog.getByRole('button', { name: 'OK' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('textbox', { name: 'Lab name' })).toHaveValue('Untitled lab');
});
