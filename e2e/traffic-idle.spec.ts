import { expect, test, type Page } from '@playwright/test';
import { openRoutedLab, type DevWindow } from './routed';

/**
 * The traffic overlay asks for animation frames only while something on it moves, so an idle
 * page costs no CPU. These tests count the frame callbacks the page runs, whoever asked for them.
 */
test.use({ viewport: { width: 1440, height: 900 } });

type FrameWindow = DevWindow & { framesRun: number; tracerTraffic: unknown };

async function countFrames(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as FrameWindow;
    w.framesRun = 0;
    const request = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback) =>
      request((now) => {
        w.framesRun += 1;
        callback(now);
      });
  });
}

/** How many frame callbacks ran over `ms` of wall time. */
const framesOver = (page: Page, ms: number) =>
  page.evaluate(async (ms) => {
    const w = window as unknown as FrameWindow;
    const before = w.framesRun;
    await new Promise((resolve) => setTimeout(resolve, ms));
    return w.framesRun - before;
  }, ms);

const expectIdle = (page: Page) =>
  expect.poll(() => framesOver(page, 500), { timeout: 10_000 }).toBe(0);

async function pingPc2(page: Page) {
  await page.waitForFunction(() => (window as unknown as Partial<FrameWindow>).tracerTraffic);
  await page.evaluate(() => {
    void (window as unknown as DevWindow).tracerSim.ping(
      'dev_PC1',
      '192.168.2.10',
      { count: 1, timeoutMs: 2000 },
      () => {},
    );
  });
}

/** Simulation mode, paused, past the switches' next hello and with spanning tree hidden. */
async function quietSimulation(page: Page) {
  await page.getByRole('radio', { name: 'Simulation' }).click();
  await page.getByRole('button', { name: 'Step forward' }).click();
  await page
    .getByRole('group', { name: 'Protocol filters' })
    .getByRole('button', { name: /STP/ })
    .click();
}

const overlay = (page: Page) => page.getByTestId('traffic-overlay');

test('in realtime, the overlay stops drawing when no packet is in flight, and starts again for a ping', async ({
  page,
}) => {
  await countFrames(page);
  await openRoutedLab(page);
  // Hidden spanning tree keeps the switches' hellos off the canvas.
  await quietSimulation(page);
  await page.getByRole('radio', { name: 'Realtime' }).click();
  await expectIdle(page);

  await pingPc2(page);
  await expect(overlay(page)).not.toHaveAttribute('data-chips', '0');
  expect(await framesOver(page, 300)).toBeGreaterThan(5);

  await expect(overlay(page)).toHaveAttribute('data-chips', '0', { timeout: 10_000 });
  await expectIdle(page);
});

test('in Simulation mode, a step’s packets slide in and rest without frames, and a selected one breathes', async ({
  page,
}) => {
  await countFrames(page);
  await openRoutedLab(page);
  await quietSimulation(page);
  await expectIdle(page);

  await pingPc2(page);
  await page.getByRole('button', { name: 'Step forward' }).click();
  await expect(overlay(page)).toHaveAttribute('data-chips', '1');
  // The chip rests where it landed, still drawn, and the page asks for no more frames.
  await expectIdle(page);
  await expect(overlay(page)).toHaveAttribute('data-chips', '1');

  await page.getByRole('grid', { name: 'Events' }).getByRole('row').nth(1).click();
  expect(await framesOver(page, 500)).toBeGreaterThan(10);
});
