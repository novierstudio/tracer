import { expect, test } from '@playwright/test';
import { fastForward, LAB } from './lab';
import { openRoutedLab, type DevWindow, type PingEvent } from './routed';

test.use({ serviceWorkers: 'allow', viewport: { width: 1440, height: 900 } });

// Opening a file goes through the file input, as in every browser without File System Access.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    delete (window as unknown as Record<string, unknown>).showOpenFilePicker;
  });
});

test('installs a manifest with the icons under /tracer/', async ({ page, request }) => {
  await page.goto('./');
  const href = await page.locator('link[rel="manifest"]').getAttribute('href');
  expect(href).toBe('/tracer/manifest.webmanifest');
  const manifest = await (await request.get(href!)).json();
  expect(manifest).toMatchObject({ name: 'Tracer', start_url: '/tracer/', scope: '/tracer/' });
  for (const { src } of manifest.icons) {
    expect((await request.get(`/tracer/${src}`)).ok()).toBe(true);
  }
});

test('after one visit, works with the network off: restores, opens and pings', async ({
  page,
  context,
}) => {
  await openRoutedLab(page);
  await expect(page.getByTitle(/Changes autosave/)).toHaveText('Saved');
  // The service worker has precached everything once it is active.
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    if (registration.active?.state !== 'activated') {
      await new Promise((resolve) =>
        registration.active?.addEventListener('statechange', resolve, { once: true }),
      );
    }
  });

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('contentinfo').getByRole('status')).toHaveText('Engine ready');
  await expect(page.getByRole('textbox', { name: 'Lab name' })).toHaveValue('Ping');
  await expect(page.locator('.react-flow__node .device-hostname').first()).toBeVisible();
  // The engine starts again after the reload, so spanning tree converges again.
  await fastForward(page);

  const events = await page.evaluate(
    () =>
      new Promise<PingEvent[]>((resolve, reject) => {
        const events: PingEvent[] = [];
        void (window as unknown as DevWindow).tracerSim
          .ping('dev_PC1', '192.168.2.10', { count: 2, timeoutMs: 1000 }, (event) => {
            events.push(event);
            if (event.kind === 'summary') resolve(events);
          })
          .then((started) => {
            if (!started.ok) reject(new Error(`ping did not start: ${started.error}`));
          });
      }),
  );
  expect(events.at(-1)).toMatchObject({ kind: 'summary', sent: 2, received: 2 });

  const choosing = page.waitForEvent('filechooser');
  await page.keyboard.press('ControlOrMeta+o');
  await (
    await choosing
  ).setFiles({
    name: 'Sessions.tracer.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(LAB)),
  });
  await expect(page.getByRole('textbox', { name: 'Lab name' })).toHaveValue('Sessions');
  await expect(page.locator('.react-flow__node .device-hostname')).toHaveText(['R1', 'SW1', 'R2']);
});
