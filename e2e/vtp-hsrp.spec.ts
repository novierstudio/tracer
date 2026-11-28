import { expect, test, type Page } from '@playwright/test';
import { fastForward, gotoCanvas, select, terminalIn } from './lab';

test.use({ viewport: { width: 1440, height: 900 } });

const device = (page: Page, hostname: string) =>
  page.getByRole('group', { name: new RegExp(`^${hostname},`) });

/** Rows wrap in the narrow inspector, so output is compared with whitespace removed. */
const squeeze = (text: string) => text.replace(/\s+/g, '');

async function openSample(page: Page, title: RegExp, hostnames: readonly string[]) {
  await page.addInitScript(() => {
    (window as unknown as { __TRACER_DEV__?: boolean }).__TRACER_DEV__ = true;
  });
  await gotoCanvas(page);
  await page.keyboard.press('ControlOrMeta+k');
  await page.keyboard.type('open sample');
  await page.keyboard.press('Enter');
  await page
    .getByRole('dialog', { name: 'Sample labs' })
    .getByRole('button', { name: title })
    .click();
  for (const hostname of hostnames) await expect(device(page, hostname)).toBeVisible();
}

/** Opens the device's CLI in the inspector and enters privileged EXEC. */
async function cliOf(page: Page, id: string, hostname: string) {
  await select(page, id);
  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  await inspector.getByRole('tab', { name: 'CLI' }).click();
  const cli = terminalIn(page, inspector);
  await cli.input.focus();
  await expect.poll(cli.lastRow).toBe(`${hostname}>`);
  await cli.run('enable', `${hostname}#`);
  const shown = async () => squeeze((await cli.rows()).join(''));
  return { cli, shown };
}

async function pingFrom(page: Page, hostname: string, target: string) {
  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  await device(page, hostname).locator('.device-tile').dblclick();
  await inspector.getByRole('button', { name: /Command Prompt/ }).click();
  const prompt = terminalIn(page, inspector);
  await expect.poll(prompt.lastRow).toBe('C:\\>');
  await page.keyboard.type(`ping ${target}`);
  await page.keyboard.press('Enter');
  const output = async () => squeeze((await prompt.rows()).join(''));
  await expect.poll(output, { timeout: 15_000 }).toContain('Sent=4,Received=4,Lost=0');
}

test('the VTP sample: clients learn the server’s VLANs, refuse their own, and PC1 pings across', async ({
  page,
}) => {
  await openSample(page, /VTP server and clients/, ['SW1', 'SW2', 'SW3', 'PC1', 'PC2']);
  await fastForward(page);

  const { shown } = await cliOf(page, 'dev_vscSW2', 'SW2');
  await page.keyboard.type('show vtp status');
  await page.keyboard.press('Enter');
  await expect.poll(shown).toContain(squeeze('VTP Domain Name                 : CCNA'));
  await expect.poll(shown).toContain(squeeze('VTP Operating Mode                : Client'));
  await expect.poll(shown).toContain(squeeze('Configuration Revision            : 4'));

  await page.keyboard.type('show vlan brief');
  await page.keyboard.press('Enter');
  await expect.poll(shown).toContain(squeeze('10   Sales'));
  await expect.poll(shown).toContain(squeeze('20   Engineering'));

  await page.keyboard.type('configure terminal');
  await page.keyboard.press('Enter');
  await page.keyboard.type('vlan 30');
  await page.keyboard.press('Enter');
  await expect
    .poll(shown)
    .toContain(squeeze('VTP VLAN configuration not allowed when device is in CLIENT mode.'));

  await pingFrom(page, 'PC1', '192.168.10.12');
});

test('the HSRP sample: R1 is active for the virtual gateway and PC1 pings the server through it', async ({
  page,
}) => {
  await openSample(page, /HSRP gateway redundancy/, ['R1', 'R2', 'R3', 'SW1', 'PC1', 'Server']);
  // Each router listens, then speaks, for a hold time of 10 s before the election settles.
  await fastForward(page, 40);

  const { shown } = await cliOf(page, 'dev_hgR1', 'R1');
  await page.keyboard.type('show standby brief');
  await page.keyboard.press('Enter');
  await expect
    .poll(shown)
    .toContain(
      squeeze('Gig0/0      1    110 P Active   local           192.168.1.3     192.168.1.1'),
    );

  await pingFrom(page, 'PC1', '192.168.2.10');
});
