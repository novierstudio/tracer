import { expect, test, type Page } from '@playwright/test';
import { fastForward, gotoCanvas } from './lab';

test.use({ viewport: { width: 1440, height: 900 } });

const device = (page: Page, hostname: string) =>
  page.getByRole('group', { name: new RegExp(`^${hostname},`) });

async function openSample(page: Page) {
  await page.addInitScript(() => {
    (window as unknown as { __TRACER_DEV__?: boolean }).__TRACER_DEV__ = true;
  });
  await gotoCanvas(page);
  await page.keyboard.press('ControlOrMeta+k');
  await page.keyboard.type('open sample');
  await page.keyboard.press('Enter');
  await page
    .getByRole('dialog', { name: 'Sample labs' })
    .getByRole('button', { name: /DNS and a web server/ })
    .click();
  for (const hostname of ['SW1', 'PC1', 'Server1']) {
    await expect(device(page, hostname)).toBeVisible();
  }
}

/** The Type column of every event row seen so far, by its position in the whole list. */
async function readTypes(page: Page, into: Map<number, string>) {
  // Read in one go: the list renders only the rows near its scroll position.
  const rows = await page
    .getByRole('grid', { name: 'Events' })
    .getByRole('rowgroup')
    .getByRole('row')
    .evaluateAll((elements) =>
      elements.map((row) => {
        const cells = [...row.querySelectorAll('[role="gridcell"]')];
        return [Number(row.getAttribute('aria-rowindex')), cells[3]?.textContent ?? ''] as const;
      }),
    );
  for (const [index, type] of rows) into.set(index, type.trim());
}

test('PC1 browses to http://www.lab.local and sees Server1’s page, and Simulation mode steps through DNS, then TCP, then HTTP', async ({
  page,
}) => {
  await openSample(page);
  // The switch holds its ports for 4 simulated seconds before it forwards.
  await fastForward(page, 5);

  await device(page, 'PC1').locator('.device-tile').dblclick();
  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  await inspector.getByRole('button', { name: /Web Browser/ }).click();
  await inspector.getByRole('textbox', { name: 'URL' }).fill('http://www.lab.local');
  await inspector.getByRole('button', { name: 'Go' }).click();

  const frame = inspector.locator('iframe[title="Page"]');
  await expect(
    frame.contentFrame().getByRole('heading', { name: 'Welcome to www.lab.local' }),
  ).toBeVisible({ timeout: 15_000 });
  // No permissions at all, so the page can never run a script.
  await expect(frame).toHaveAttribute('sandbox', '');

  await page.getByRole('radio', { name: 'Simulation' }).click();
  await expect(page.getByRole('toolbar', { name: 'Simulation timeline' })).toBeVisible();
  await inspector.getByRole('button', { name: 'Go' }).click();

  const types = new Map<number, string>();
  const step = page.getByRole('button', { name: 'Step forward' });
  for (let steps = 0; steps < 60 && ![...types.values()].includes('HTTP'); steps++) {
    await step.click();
    await readTypes(page, types);
  }
  const order = [...types].sort(([a], [b]) => a - b).map(([, type]) => type);
  const first = (type: string) => order.indexOf(type);
  expect(first('DNS')).toBeGreaterThanOrEqual(0);
  expect(first('DNS')).toBeLessThan(first('TCP'));
  expect(first('TCP')).toBeLessThan(first('HTTP'));
});
