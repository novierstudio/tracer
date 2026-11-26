import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { fastForward, terminalIn } from './lab';

type DevWindow = {
  __TRACER_DEV__?: boolean;
  tracer: {
    loadLab(input: unknown): void;
    editorStore: {
      getState(): { select(selection: { devices: string[]; links: string[] }): void };
    };
  };
};

test.use({ viewport: { width: 1440, height: 900 } });

/** The "DHCP on a router" sample lab: R1 serving its pool to PC1 and PC2, both on DHCP, on SW1. */
const LAB: unknown = JSON.parse(
  readFileSync(new URL('../src/labs/dhcp-router.tracer.json', import.meta.url), 'utf8'),
);

const LEASED = /^ {3}IPv4 Address(?:\. )+\. : (192\.168\.1\.1[12])$/;

const select = (page: Page, device: string) =>
  page.evaluate((id) => {
    (window as unknown as DevWindow).tracer.editorStore
      .getState()
      .select({ devices: [id], links: [] });
  }, device);

const bottomPanel = (page: Page) => page.getByRole('region', { name: 'Bottom panel' });
const pduInspector = (page: Page) => page.getByRole('complementary', { name: 'PDU inspector' });
const eventGrid = (page: Page) => page.getByRole('grid', { name: 'Events' });

type Terminal = ReturnType<typeof terminalIn>;

/**
 * Types a line and waits until the prompt is back and `done` holds for what is on screen. The
 * panel is shorter than some outputs, so the echoed line may have scrolled away by then.
 */
async function enter(
  page: Page,
  terminal: Terminal,
  line: string,
  prompt: string,
  done: (rows: string[]) => boolean = () => true,
) {
  await terminal.input.focus();
  await page.keyboard.type(line);
  await page.keyboard.press('Enter');
  await expect
    .poll(
      async () => {
        const rows = await terminal.rows();
        return rows.at(-1) === prompt && done(rows);
      },
      { timeout: 15_000 },
    )
    .toBe(true);
}

/** Opens the lab and runs the clock on until spanning tree forwards and both PCs hold leases. */
async function openDhcpLab(page: Page) {
  await page.addInitScript(() => {
    (window as unknown as DevWindow).__TRACER_DEV__ = true;
  });
  await page.goto('./');
  await expect(page.getByRole('contentinfo').getByRole('status')).toHaveText('Engine ready');
  await page.evaluate((topology) => {
    (window as unknown as DevWindow).tracer.loadLab(topology);
  }, LAB);
  // Discovers sent before spanning tree forwards go unanswered; the third, at 12 s, gets through.
  await fastForward(page, 16);
}

test('PCs lease addresses from R1, ping their gateway, and R1 lists the bindings', async ({
  page,
}) => {
  await openDhcpLab(page);

  // The canvas shows each PC's leased address under its name.
  for (const pc of ['dev_drPC1', 'dev_drPC2']) {
    await expect(page.locator(`.react-flow__node[data-id="${pc}"] .device-address`)).toHaveText(
      /^192\.168\.1\.1[12]$/,
    );
  }

  await select(page, 'dev_drPC1');
  await page.getByRole('button', { name: 'Toggle bottom panel' }).click();
  await bottomPanel(page).getByRole('tab', { name: 'Terminal' }).click();
  await expect(bottomPanel(page)).toContainText('PC1 Command Prompt');
  const prompt = terminalIn(page, bottomPanel(page));
  await expect.poll(prompt.lastRow).toBe('C:\\>');

  await enter(page, prompt, 'ipconfig /all', 'C:\\>', (rows) =>
    rows.some((row) => row.includes('DNS Servers')),
  );
  expect(await prompt.rows()).toEqual(
    expect.arrayContaining([
      '   IPv6 Address. . . . . . . . . . . : ::',
      expect.stringMatching(LEASED),
      '   Subnet Mask . . . . . . . . . . . : 255.255.255.0',
      expect.stringMatching(/^ {3}Lease Obtained(?:\. )+\. : \w+day, /),
      expect.stringMatching(/^ {3}Lease Expires(?: \.)+ : \w+day, /),
      '   Default Gateway . . . . . . . . . : ::',
      '                                       192.168.1.1',
      '   DHCP Server . . . . . . . . . . . : 192.168.1.1',
      '   DNS Servers . . . . . . . . . . . : 8.8.8.8',
    ]),
  );

  await enter(page, prompt, 'ping 192.168.1.1', 'C:\\>', (rows) =>
    rows.some((row) => row.includes('Ping statistics')),
  );
  expect(await prompt.rows()).toContain('    Packets: Sent = 4, Received = 4, Lost = 0 (0% loss),');

  await select(page, 'dev_drR1');
  await expect(bottomPanel(page)).toContainText('R1 console');
  const console = terminalIn(page, bottomPanel(page));
  await expect.poll(console.lastRow).toBe('R1>');
  await enter(page, console, 'enable', 'R1#');
  await enter(page, console, 'show ip dhcp binding', 'R1#', (rows) =>
    rows.some((row) => row.startsWith('Bindings from all pools')),
  );
  const binding = (address: string) =>
    new RegExp(
      `^${address.replaceAll('.', '\\.')} +[0-9a-f]{4}\\.[0-9a-f]{4}\\.[0-9a-f]{4} +Mar 02 1993 12:00 AM +Automatic$`,
    );
  expect((await console.rows()).filter((row) => row.startsWith('192.168.1.'))).toEqual([
    expect.stringMatching(binding('192.168.1.11')),
    expect.stringMatching(binding('192.168.1.12')),
  ]);
});

test('in Simulation mode, a release and renew steps through a DORA, with the Offer in the PDU inspector', async ({
  page,
}) => {
  await openDhcpLab(page);
  await page.getByRole('radio', { name: 'Simulation' }).click();
  await expect(page.getByRole('toolbar', { name: 'Simulation timeline' })).toBeVisible();

  await select(page, 'dev_drPC2');
  const tab = (name: string) => bottomPanel(page).getByRole('tab', { name });
  await tab('Terminal').click();
  await expect(bottomPanel(page)).toContainText('PC2 Command Prompt');
  const prompt = terminalIn(page, bottomPanel(page));
  await expect.poll(prompt.lastRow).toBe('C:\\>');
  await enter(page, prompt, 'ipconfig /release', 'C:\\>', (rows) =>
    rows.includes('   IPv4 Address. . . . . . . . . . . : 0.0.0.0'),
  );
  // The renewal waits for the DHCP server, which answers only as the simulation steps.
  await page.keyboard.type('ipconfig /renew');
  await page.keyboard.press('Enter');

  await tab('Events').click();
  // Spanning tree's BPDUs would fill the list, so hide them once a step shows one.
  const stp = page.getByRole('group', { name: 'Protocol filters' }).getByRole('button', {
    name: /STP/,
  });
  const step = async () => {
    await page.getByRole('button', { name: 'Step forward' }).click();
    if ((await stp.count()) > 0 && (await stp.getAttribute('aria-pressed')) === 'true') {
      await stp.click();
    }
  };
  const rowsWith = (text: string) =>
    eventGrid(page).getByRole('row').filter({ hasText: text }).filter({ hasText: 'PC2' });
  for (let steps = 0; steps < 20 && (await rowsWith('DHCP Offer').count()) === 0; steps++) {
    await step();
  }
  await expect(rowsWith('DHCP Discover').first()).toBeVisible();
  await rowsWith('DHCP Offer').first().click();

  await expect(pduInspector(page).getByRole('status', { name: 'What the device did' })).toHaveText(
    /^PC2 took the offer of 192\.168\.1\.1[12] and broadcast a Request for it out Fa0\.$/,
  );
  await expect(pduInspector(page).getByRole('tab', { name: /^L7 DHCP Offer/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  const field = (id: string) => pduInspector(page).locator(`[data-field="${id}"]`);
  await expect(field('dhcp.option.53')).toContainText('2 (Offer)');
  await expect(field('dhcp.yiaddr')).toContainText(/192\.168\.1\.1[12]/);
  await expect(field('dhcp.option.3')).toContainText('192.168.1.1');

  // Step on until the Ack lands, and the renewal prints PC2's new lease.
  for (let steps = 0; steps < 20 && (await rowsWith('DHCP Ack').count()) === 0; steps++) {
    await step();
  }
  await expect(rowsWith('DHCP Ack').first()).toBeVisible();
  await tab('Terminal').click();
  await expect
    .poll(async () => {
      const rows = await prompt.rows();
      return rows.at(-1) === 'C:\\>' && rows.some((row) => LEASED.test(row));
    })
    .toBe(true);
});
