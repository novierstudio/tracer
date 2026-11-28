import { expect, test, type Page } from '@playwright/test';
import { gotoCanvas, terminalIn } from './lab';

test.use({ viewport: { width: 1440, height: 900 } });

const canvas = (page: Page) => page.getByRole('main', { name: 'Canvas' });
const device = (page: Page, hostname: string) =>
  page.getByRole('group', { name: new RegExp(`^${hostname},`) });
const inspector = (page: Page) => page.getByRole('complementary', { name: 'Inspector' });

async function dropDevice(page: Page, name: string, x: number, y: number) {
  await page
    .getByRole('complementary', { name: 'Device palette' })
    .getByText(name, { exact: true })
    .dragTo(canvas(page), { targetPosition: { x, y } });
}

test('an HWIC-2T fitted to a 2911 with the power off adds Serial0/0/0', async ({ page }) => {
  await gotoCanvas(page);
  await dropDevice(page, '2911', 360, 200);
  await dropDevice(page, '2960-24TT', 620, 420);
  await expect(device(page, 'Switch0')).toBeVisible();

  await device(page, 'Router0').locator('.device-tile').click();
  await inspector(page).getByRole('tab', { name: 'Physical' }).click();
  const slot = inspector(page).getByRole('combobox', { name: 'Slot 0/0' });
  await expect(slot).toBeDisabled();

  const power = inspector(page).getByRole('switch', { name: 'Power' });
  await power.click();
  await expect(power).not.toBeChecked();
  await slot.selectOption('HWIC-2T');
  await expect(inspector(page).getByText(/Se0\/0\/0, Se0\/0\/1/)).toBeVisible();
  await power.click();
  await expect(slot).toBeDisabled();

  await inspector(page).getByRole('tab', { name: 'CLI' }).click();
  const terminal = terminalIn(page, inspector(page));
  await expect.poll(terminal.lastRow).toBe('Router0>');
  await terminal.input.focus();
  await terminal.run('show ip interface brief', 'Router0>');
  // The inspector's terminal is narrow, so each row wraps after the IP-Address column.
  const interfaces = (await terminal.rows()).map((row) => /^(\S+)\s+unassigned$/.exec(row)?.[1]);
  expect(interfaces.filter(Boolean)).toEqual([
    'GigabitEthernet0/0',
    'GigabitEthernet0/1',
    'GigabitEthernet0/2',
    'Serial0/0/0',
    'Serial0/0/1',
  ]);
});
