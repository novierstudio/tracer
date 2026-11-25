import { expect, test, type Page } from '@playwright/test';
import { openRoutedLab, type DevWindow } from './routed';

test.use({ viewport: { width: 1440, height: 900 } });

type Chip = { event: number; link: string; protocol: string; motion: string };
type TrafficWindow = DevWindow & { tracerTraffic: { chips(): Chip[] } };

const chips = (page: Page) =>
  page.evaluate(() => (window as unknown as TrafficWindow).tracerTraffic.chips());

/** Starts a one-echo ping from PC1 to PC2 through the dev handle, once the canvas has loaded. */
async function pingPc2(page: Page) {
  await page.waitForFunction(() => (window as unknown as Partial<TrafficWindow>).tracerTraffic);
  await page.evaluate(() => {
    const options = { count: 1, timeoutMs: 2000 };
    void (window as unknown as DevWindow).tracerSim.ping(
      'dev_PC1',
      '192.168.2.10',
      options,
      () => {},
    );
  });
}

/** Every hop of PC1 pinging PC2 across R1: ARP for R1, the echo, ARP for PC2, and back. */
const HOPS = [
  ['PC1', 'SW1', 'ARP', 'lnk_1'],
  ['SW1', 'R1', 'ARP', 'lnk_2'],
  ['R1', 'SW1', 'ARP', 'lnk_2'],
  ['SW1', 'PC1', 'ARP', 'lnk_1'],
  ['PC1', 'SW1', 'ICMP', 'lnk_1'],
  ['SW1', 'R1', 'ICMP', 'lnk_2'],
  ['R1', 'SW2', 'ARP', 'lnk_3'],
  ['SW2', 'PC2', 'ARP', 'lnk_4'],
  ['PC2', 'SW2', 'ARP', 'lnk_4'],
  ['SW2', 'R1', 'ARP', 'lnk_3'],
  ['R1', 'SW2', 'ICMP', 'lnk_3'],
  ['SW2', 'PC2', 'ICMP', 'lnk_4'],
  ['PC2', 'SW2', 'ICMP', 'lnk_4'],
  ['SW2', 'R1', 'ICMP', 'lnk_3'],
  ['R1', 'SW1', 'ICMP', 'lnk_2'],
  ['SW1', 'PC1', 'ICMP', 'lnk_1'],
] as const;

const eventGrid = (page: Page) => page.getByRole('grid', { name: 'Events' });
const eventRows = (page: Page) => eventGrid(page).getByRole('rowgroup').getByRole('row');

/**
 * The list renders only the rows near its scroll position; the grid's row count has them all. With
 * no events there is no grid, and with every event filtered out there is one with only its header.
 */
async function expectRowCount(page: Page, count: number) {
  if (count === 0) {
    const empty = async () =>
      (await eventGrid(page).count()) === 0 ||
      (await eventGrid(page).getAttribute('aria-rowcount')) === '1';
    await expect.poll(empty).toBe(true);
  } else {
    await expect(eventGrid(page)).toHaveAttribute('aria-rowcount', String(count + 1));
  }
}

/** Last device, at device and type of each rendered row, by its position in the whole list. */
async function rowHops(page: Page) {
  // Read in one go: scrolling re-renders the rows.
  const rows = await eventRows(page).evaluateAll((elements) =>
    elements.map((row) => {
      const cells = [...row.querySelectorAll('[role="gridcell"]')].map((c) => c.textContent ?? '');
      return [Number(row.getAttribute('aria-rowindex')) - 2, cells.slice(1, 4)] as const;
    }),
  );
  return new Map<number, string[]>(rows);
}

async function lastRowHop(page: Page) {
  const hops = await rowHops(page);
  return hops.get(Math.max(...hops.keys()));
}

async function enterSimulation(page: Page) {
  await page.getByRole('radio', { name: 'Simulation' }).click();
  await expect(page.getByRole('toolbar', { name: 'Simulation timeline' })).toBeVisible();
}

/**
 * Steps past the switches' next hello, then hides spanning tree. Their BPDUs cross the switch links
 * every 2 s, and a step stops at them whatever the filters show, so a ping then has 2 s of quiet.
 */
async function skipNextHello(page: Page) {
  await page.getByRole('button', { name: 'Step forward' }).click();
  await page
    .getByRole('group', { name: 'Protocol filters' })
    .getByRole('button', { name: /STP/ })
    .click();
  await expectRowCount(page, 0);
}

test('in realtime, a ping across the router shows ARP and ICMP chips on the links they cross', async ({
  page,
}) => {
  await openRoutedLab(page);
  await pingPc2(page);

  const seen = new Set<string>();
  await expect
    .poll(
      async () => {
        // Spanning tree hellos cross the switch links on their own every 2 s.
        for (const chip of await chips(page)) {
          if (chip.protocol !== 'stp') seen.add(`${chip.protocol} ${chip.link}`);
        }
        return [...seen];
      },
      { intervals: [50] },
    )
    .toEqual(
      expect.arrayContaining(['arp lnk_1', 'arp lnk_2', 'arp lnk_4', 'icmp lnk_1', 'icmp lnk_4']),
    );
  for (const chip of seen) expect(chip).toMatch(/^(arp|icmp) lnk_[1-4]$/);
});

test('Show traffic turns the chips off', async ({ page }) => {
  await openRoutedLab(page);
  const toggle = page.getByRole('button', { name: 'Show traffic' });
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await toggle.click();
  await pingPc2(page);
  await page.waitForTimeout(500);
  expect(await chips(page)).toEqual([]);
});

test('in Simulation mode, a cross-router ping steps hop by hop, forwards and back, in sync', async ({
  page,
}) => {
  await openRoutedLab(page);
  await enterSimulation(page);
  await expect(page.getByRole('button', { name: 'Step back' })).toBeDisabled();
  await skipNextHello(page);
  await pingPc2(page);
  // Paused: nothing moves until a step.
  await page.waitForTimeout(200);
  await expectRowCount(page, 0);

  for (const [index, [from, to, type, link]] of HOPS.entries()) {
    await page.getByRole('button', { name: 'Step forward' }).click();
    await expectRowCount(page, index + 1);
    expect(await lastRowHop(page)).toEqual([from, to, type]);
    await expect(eventRows(page).last()).toHaveAttribute('data-current', 'true');
    await expect
      .poll(() => chips(page))
      .toEqual([expect.objectContaining({ link, protocol: type.toLowerCase(), motion: 'arrive' })]);
  }

  for (let index = HOPS.length - 2; index >= 0; index--) {
    await page.keyboard.press('ArrowLeft');
    await expectRowCount(page, index + 1);
    const [from, to, type, link] = HOPS[index]!;
    expect(await lastRowHop(page)).toEqual([from, to, type]);
    await expect
      .poll(async () => (await chips(page)).filter((chip) => chip.motion === 'rest'))
      .toEqual([expect.objectContaining({ link, protocol: type.toLowerCase() })]);
  }

  // Forward again replays the same hops.
  for (let index = 1; index < HOPS.length; index++) await page.keyboard.press('ArrowRight');
  await expectRowCount(page, HOPS.length);
  for (const [index, hop] of await rowHops(page)) expect(hop).toEqual(HOPS[index]!.slice(0, 3));
});

test('filtering out ARP hides its rows and its chips, and clicking a row pans to the packet', async ({
  page,
}) => {
  await openRoutedLab(page);
  await enterSimulation(page);
  await skipNextHello(page);
  await pingPc2(page);
  const step = page.getByRole('button', { name: 'Step forward' });
  for (let index = 0; index < 8; index++) await step.click();
  await expectRowCount(page, 8);

  const filters = page.getByRole('group', { name: 'Protocol filters' });
  await filters.getByRole('button', { name: /ARP/ }).click();
  await expect(filters.getByRole('button', { name: /ARP/ })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await expectRowCount(page, 2);
  expect([...(await rowHops(page)).values()].map(([, , type]) => type)).toEqual(['ICMP', 'ICMP']);
  // Hop 8 is ARP, now hidden on the canvas too.
  await expect.poll(() => chips(page)).toEqual([]);

  // Zoomed in on R1, the first row's packet (PC1 to SW1) is off to the left: the click pans to it.
  const zoom = page.getByRole('toolbar', { name: 'Zoom' });
  await expect(async () => {
    await zoom.getByRole('button', { name: 'Zoom in' }).click();
    const label = await zoom
      .getByRole('button', { name: /^Zoom to 100%/ })
      .getAttribute('aria-label');
    expect(Number(/now (\d+)%/.exec(label ?? '')?.[1])).toBeGreaterThanOrEqual(200);
  }).toPass();
  const viewport = page.locator('.react-flow__viewport');
  await page.waitForTimeout(400);
  const before = await viewport.getAttribute('style');
  await eventRows(page).first().click();
  await expect(eventRows(page).first()).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => viewport.getAttribute('style')).not.toBe(before);

  await filters.getByRole('button', { name: /ARP/ }).click();
  await expectRowCount(page, 8);
});

test('the Add simple PDU tool queues an echo from the clicked source to the clicked destination', async ({
  page,
}) => {
  await openRoutedLab(page);
  await enterSimulation(page);
  await skipNextHello(page);
  // The bottom panel took room from the canvas: fit the lab into what is left.
  await page.keyboard.press('1');

  await page.getByRole('button', { name: 'Add simple PDU' }).first().click();
  await expect(
    page.getByRole('status').filter({ hasText: 'click the device that sends' }),
  ).toBeVisible();
  await page.locator('.react-flow__node[data-id="dev_PC1"]').click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Click the device it pings' }),
  ).toBeVisible();
  await page.locator('.react-flow__node[data-id="dev_PC2"]').click();

  const status = page.getByRole('status', { name: 'Last PDU' });
  await expect(status).toHaveText('PC1 → PC2 in flight');
  await page.getByRole('button', { name: 'Step forward' }).click();
  await expectRowCount(page, 1);
  expect(await lastRowHop(page)).toEqual(['PC1', 'SW1', 'ARP']);

  await page.getByRole('radio', { name: '4×' }).click();
  await page.getByRole('button', { name: 'Play' }).click();
  await expect(status).toHaveText('PC1 → PC2 successful', { timeout: 10_000 });
  await expectRowCount(page, HOPS.length);
});
