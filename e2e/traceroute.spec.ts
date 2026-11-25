import { expect, test } from '@playwright/test';
import { select, terminalIn } from './lab';
import { openRoutedLab } from './routed';

test.use({ viewport: { width: 1440, height: 900 } });

test('traces, pings until Ctrl+C and clears ARP from PC1, and traces from R1', async ({ page }) => {
  // Four commands, one of them a second per reply in real time, need longer than the default.
  test.setTimeout(60_000);
  await openRoutedLab(page);
  await select(page, 'dev_PC1');
  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  await inspector.getByRole('tab', { name: 'Desktop' }).click();
  await inspector.getByRole('button', { name: /Command Prompt/ }).click();

  // The bottom panel shows the same session, wide enough that no line wraps.
  await page.getByRole('button', { name: 'Toggle bottom panel' }).click();
  const panel = page.getByRole('region', { name: 'Bottom panel' });
  await panel.getByRole('tab', { name: 'Terminal' }).click();
  await expect(panel).toContainText('PC1 Command Prompt');
  const prompt = terminalIn(page, panel);
  await expect.poll(prompt.lastRow).toBe('C:\\>');
  await prompt.input.focus();

  await prompt.run('tracert 192.168.2.10', 'C:\\>');
  const traced = await prompt.rows();
  const hops = traced.slice(traced.indexOf('C:\\>tracert 192.168.2.10') + 1, -1);
  const time = ' +(?:<1|\\d+) ms';
  expect(hops).toEqual([
    'Tracing route to 192.168.2.10 over a maximum of 30 hops',
    expect.stringMatching(new RegExp(`^ {2}1${time}${time}${time} {2}192\\.168\\.1\\.1$`)),
    expect.stringMatching(new RegExp(`^ {2}2${time}${time}${time} {2}192\\.168\\.2\\.10$`)),
    'Trace complete.',
  ]);

  await page.keyboard.type('ping -t 192.168.2.10');
  await page.keyboard.press('Enter');
  const replies = async () =>
    (await prompt.rows()).filter((row) => row.startsWith('Reply from 192.168.2.10')).length;
  await expect.poll(replies, { timeout: 10_000 }).toBeGreaterThanOrEqual(3);
  await page.keyboard.press('Control+C');
  await expect.poll(prompt.lastRow).toBe('C:\\>');
  const pinged = await prompt.rows();
  expect(pinged.slice(pinged.indexOf('Ping statistics for 192.168.2.10:'))).toEqual([
    'Ping statistics for 192.168.2.10:',
    expect.stringMatching(/^ {4}Packets: Sent = (\d+), Received = \1, Lost = 0 \(0% loss\),$/),
    'Approximate round trip times in milli-seconds:',
    expect.stringMatching(/^ {4}Minimum = \d+ms, Maximum = \d+ms, Average = \d+ms$/),
    'Control-C',
    '^C',
    'C:\\>',
  ]);

  await prompt.run('arp -a', 'C:\\>');
  expect(await prompt.rows()).toContain('Interface: 192.168.1.10 --- 0x2');
  await page.keyboard.type('cls');
  await page.keyboard.press('Enter');
  await expect.poll(prompt.rows).toEqual(['C:\\>']);
  await prompt.run('arp -d', 'C:\\>');
  await prompt.run('arp -a', 'C:\\>');
  expect(await prompt.rows()).toEqual([
    'C:\\>arp -d',
    'C:\\>arp -a',
    'No ARP Entries Found.',
    'C:\\>',
  ]);

  await select(page, 'dev_R1');
  await inspector.getByRole('tab', { name: 'CLI' }).click();
  const cli = terminalIn(page, inspector);
  await cli.input.focus();
  await page.keyboard.press('Enter');
  await expect.poll(cli.lastRow).toBe('R1>');
  // The inspector is narrower than IOS output, so long rows wrap; compare without spaces.
  const text = async () => (await cli.rows()).join('').replace(/\s+/g, '');
  await page.keyboard.type('traceroute 192.168.2.10');
  await page.keyboard.press('Enter');
  await expect
    .poll(text, { timeout: 20_000 })
    .toMatch(
      /R1>traceroute192\.168\.2\.10Typeescapesequencetoabort\.Tracingtherouteto192\.168\.2\.101192\.168\.2\.10\d+msec\d+msec\d+msecR1>$/,
    );
});
