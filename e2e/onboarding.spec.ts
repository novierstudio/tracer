import { expect, test, type Page } from '@playwright/test';
import { fastForward, terminalIn } from './lab';

test.use({ viewport: { width: 1440, height: 900 } });

const device = (page: Page, hostname: string) =>
  page.getByRole('group', { name: new RegExp(`^${hostname},`) });

const welcome = (page: Page) => page.getByRole('region', { name: 'Welcome to Tracer' });

async function firstVisit(page: Page) {
  await page.addInitScript(() => {
    (window as unknown as { __TRACER_DEV__?: boolean }).__TRACER_DEV__ = true;
  });
  await page.goto('./');
  await expect(page.locator('.react-flow__pane')).toBeVisible();
}

test('a first visit opens Router on a stick from the welcome card and pings across VLANs', async ({
  page,
}) => {
  await firstVisit(page);
  await expect(welcome(page)).toBeVisible();

  await welcome(page)
    .getByRole('button', { name: /Open a sample lab/ })
    .click();
  const gallery = page.getByRole('dialog', { name: 'Sample labs' });
  await gallery.getByRole('button', { name: /Router on a stick/ }).click();
  await expect(gallery).toBeHidden();

  for (const hostname of ['R1', 'SW1', 'PC1', 'PC2', 'PC3', 'PC4']) {
    await expect(device(page, hostname)).toBeVisible();
  }
  await expect(page.getByRole('textbox', { name: 'Lab name' })).toHaveValue('Router on a stick');
  await expect(welcome(page)).toBeHidden();

  const checklist = page.getByRole('region', { name: 'Try this' });
  await expect(checklist).toContainText('Router on a stick');
  const firstStep = checklist.getByRole('checkbox').first();
  await firstStep.click();
  await expect(firstStep).toHaveAttribute('aria-checked', 'true');
  await expect(checklist.getByLabel('Progress')).toHaveText('1/4');

  // Double-clicking a PC opens its Desktop in the inspector.
  await device(page, 'PC1').locator('.device-tile').dblclick();
  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  await inspector.getByRole('button', { name: /Command Prompt/ }).click();
  const prompt = terminalIn(page, inspector);
  await expect.poll(prompt.lastRow).toBe('C:\\>');

  await fastForward(page);
  await page.keyboard.type('ping 192.168.20.10');
  await page.keyboard.press('Enter');
  // The inspector is narrower than the output, so rows wrap: compare with whitespace removed.
  const output = async () => (await prompt.rows()).join('').replace(/\s/g, '');
  await expect.poll(output, { timeout: 15_000 }).toContain('Sent=4,Received=4,Lost=0');
  expect((await output()).match(/Replyfrom192\.168\.20\.10:bytes=32/g)).toHaveLength(4);
});

test('a dismissed welcome stays dismissed after a reload, even on an empty lab', async ({
  page,
}) => {
  await firstVisit(page);
  await welcome(page).getByRole('button', { name: 'Close welcome' }).click();
  await expect(welcome(page)).toBeHidden();
  await expect(page.getByText('Your lab is empty')).toBeVisible();

  await page.reload();
  await expect(page.locator('.react-flow__pane')).toBeVisible();
  await expect(page.getByText('Your lab is empty')).toBeVisible();
  await expect(welcome(page)).toBeHidden();

  // Help brings it back.
  await page.getByRole('button', { name: 'Tracer menu' }).click();
  await page.getByRole('menuitem', { name: 'Welcome' }).click();
  await expect(welcome(page)).toBeVisible();
});

test('opening a sample keeps the lab it replaces in Recent labs', async ({ page }) => {
  await firstVisit(page);
  await welcome(page)
    .getByRole('button', { name: /Open a sample lab/ })
    .click();
  await page
    .getByRole('dialog', { name: 'Sample labs' })
    .getByRole('button', { name: /Two PCs and a switch/ })
    .click();
  await expect(device(page, 'SW1')).toBeVisible();

  await page.keyboard.press('ControlOrMeta+k');
  await page.keyboard.type('open sample');
  await page.keyboard.press('Enter');
  await page
    .getByRole('dialog', { name: 'Sample labs' })
    .getByRole('button', { name: /Two LANs and a router/ })
    .click();
  await expect(device(page, 'R1')).toBeVisible();

  await page.getByRole('button', { name: 'Tracer menu' }).click();
  await expect(page.getByRole('menuitem', { name: 'Two PCs and a switch' })).toBeVisible();
});
