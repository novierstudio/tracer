import { expect, test } from '@playwright/test';
import { fastForward, openLab, select, terminalIn } from './lab';

test.use({ viewport: { width: 1440, height: 900 } });

const SW1_CONFIG = [
  'enable',
  'configure terminal',
  'interface vlan 1',
  'ip address 192.168.1.2 255.255.255.0',
  'no shutdown',
  'end',
];

const R1_CONFIG = [
  'enable',
  'configure terminal',
  'interface g0/0',
  'ip address 192.168.1.1 255.255.255.0',
  'no shutdown',
  'end',
];

test('filters show output with a pipe and pings a neighbour from the R1 CLI', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openLab(page);
  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  const cli = terminalIn(page, inspector);
  /** Pastes a config into the device's CLI and waits for the last prompt. */
  const paste = async (device: string, lines: string[], prompt: string) => {
    await select(page, device);
    await inspector.getByRole('tab', { name: 'CLI' }).click();
    await cli.input.focus();
    await page.evaluate((text) => navigator.clipboard.writeText(text), `${lines.join('\n')}\n`);
    await page.keyboard.press('ControlOrMeta+V');
    await expect.poll(cli.lastRow).toBe(prompt);
  };

  // SW1 answers on its VLAN 1 interface, across the cable from R1's g0/0.
  await paste('dev_SW1', SW1_CONFIG, 'SW1#');
  await paste('dev_R1', R1_CONFIG, 'R1#');

  // The inspector is narrower than IOS output, so long rows wrap; compare without spaces.
  const text = async () => (await cli.rows()).join('').replace(/\s+/g, '');
  const interfaces = [0, 1, 2, 3].map((n) => `interface GigabitEthernet0/${n}`);

  await page.keyboard.type('show running-config | include interface');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await cli.rows()).slice(-5)).toEqual([...interfaces, 'R1#']);
  expect(await text()).toContain(
    `R1#showrunning-config|includeinterface${interfaces.join('').replace(/\s+/g, '')}R1#`,
  );

  // SW1's VLAN 1 interface answers only once spanning tree forwards the port R1 just brought up.
  await fastForward(page);
  await page.keyboard.type('ping 192.168.1.2');
  await page.keyboard.press('Enter');
  await expect
    .poll(text, { timeout: 20_000 })
    .toContain(
      'R1#ping192.168.1.2Typeescapesequencetoabort.' +
        'Sending5,100-byteICMPEchosto192.168.1.2,timeoutis2seconds:' +
        '!!!!!Successrateis100percent(5/5)',
    );
  await expect.poll(cli.lastRow).toBe('R1#');
});
