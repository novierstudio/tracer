import { expect, test } from '@playwright/test';
import { openLab, select, terminalIn } from './lab';

// Tall enough that R1's whole running-config fits in the terminal's visible rows.
test.use({ viewport: { width: 1440, height: 1600 } });

test('configures R1 from the Config tab, sees it in show run, and undoes the last form', async ({
  page,
}) => {
  await openLab(page);
  await select(page, 'dev_R1');
  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  await inspector.getByRole('tab', { name: 'Config' }).click();
  await inspector.getByRole('switch', { name: 'Show equivalent IOS' }).click();

  const interfaces = inspector.getByRole('region', { name: 'Interfaces' });
  await interfaces.getByRole('button', { name: 'Edit Gi0/1' }).click();
  const form = interfaces.getByRole('form', { name: 'Gi0/1 settings' });
  await form.getByLabel('Description').fill('Lab LAN');
  await form.getByLabel('IP address').fill('10.1.1.1');
  await form.getByLabel('Subnet mask').fill('255.255.255.0');
  const preview = interfaces.getByRole('figure', { name: 'IOS commands' });
  await expect(preview).toContainText('Will run');
  await expect(preview).toContainText('ip address 10.1.1.1 255.255.255.0');
  await form.getByRole('button', { name: 'Apply' }).click();
  await expect(preview).toContainText('Last run');
  await expect(interfaces.getByRole('listitem', { name: 'Gi0/1' })).toContainText('10.1.1.1/24');

  const routes = inspector.getByRole('region', { name: 'Static routes' });
  const addRoute = routes.getByRole('form', { name: 'Add a static route' });
  await addRoute.getByLabel('Network').fill('172.16.0.0');
  await addRoute.getByLabel('Mask').fill('255.255.0.0');
  await addRoute.getByLabel('Next-hop address').fill('10.1.1.2');
  await addRoute.getByRole('button', { name: 'Add route' }).click();
  await expect(routes.getByRole('listitem', { name: '172.16.0.0/16 via 10.1.1.2' })).toBeVisible();

  const cli = terminalIn(page, inspector);
  await inspector.getByRole('tab', { name: 'CLI' }).click();
  await expect.poll(cli.lastRow).toBe('R1>');
  await cli.run('enable', 'R1#');
  await cli.run('show running-config', 'R1#');
  // The inspector's terminal is narrow, so long lines wrap onto several rows. Compare the text
  // with whitespace removed, which joins wrapped rows back up.
  const squash = (text: string) => text.replace(/\s+/g, '');
  const transcript = async () => squash((await cli.rows()).join(''));
  const lines = {
    header: 'interface GigabitEthernet0/1',
    description: ' description Lab LAN',
    address: ' ip address 10.1.1.1 255.255.255.0',
    route: 'ip route 172.16.0.0 255.255.0.0 10.1.1.2',
  };
  const shown = await transcript();
  expect(shown).toContain(squash(lines.header + lines.description + lines.address));
  expect(shown).toContain(squash(lines.route));

  await page.getByRole('button', { name: 'Undo' }).click();
  await cli.input.focus();
  // A different spelling, so its echo tells the new output from the old.
  await page.keyboard.type('show run');
  await page.keyboard.press('Enter');
  await expect
    .poll(async () => {
      const rows = await cli.rows();
      return rows.includes('R1#show run') && rows.at(-1) === 'R1#' && rows.at(-2) === 'end';
    })
    .toBe(true);
  const latest = (await transcript()).split(squash('R1#show run')).at(-1)!;
  expect(latest).toContain(squash(lines.address));
  expect(latest).not.toContain(squash(lines.route));
});
