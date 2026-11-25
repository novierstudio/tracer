import { expect, test, type Page } from '@playwright/test';
import { openRoutedLab, type DevWindow, type PingEvent } from './routed';

/**
 * The frame rate while the canvas draws traffic: PC1 pings PC2 across R1 `PINGS_PER_SECOND`
 * times a second in realtime with Show traffic on. Run it on demand, against the production
 * build the e2e server serves:
 *
 *   PERF=1 E2E_PORT=4341 pnpm test:e2e traffic.perf
 *
 * Each run prints one JSON line: frames per second, frame intervals, chips on screen, and the
 * pings answered, so a run that measured an idle canvas or failed pings shows as such.
 */
test.skip(!process.env.PERF, 'measures only on demand');
test.use({ viewport: { width: 1440, height: 900 } });
test.setTimeout(120_000);

const RATES = (process.env.PERF_RATES ?? '50').split(',').map(Number);
const RUNS = Number(process.env.PERF_RUNS ?? 5);
const WARMUP_MS = 3000;
const MEASURE_MS = 5000;
const SHOW_TRAFFIC = process.env.PERF_TRAFFIC !== 'off';

type TrafficWindow = DevWindow & {
  tracerTraffic: { chips(): unknown[] };
  perfLoad?: { started: number; replies: number; failures: number; stop(): void };
};

async function startLoad(page: Page, perSecond: number) {
  await page.evaluate((perSecond) => {
    const w = window as unknown as TrafficWindow;
    const load = { started: 0, replies: 0, failures: 0, stop: () => clearInterval(timer) };
    const timer = setInterval(() => {
      load.started += 1;
      void w.tracerSim.ping(
        'dev_PC1',
        '192.168.2.10',
        { count: 1, timeoutMs: 1000 },
        (event: PingEvent) => {
          if (event.kind === 'reply') load.replies += 1;
          else if (event.kind !== 'summary') load.failures += 1;
        },
      );
    }, 1000 / perSecond);
    w.perfLoad = load;
  }, perSecond);
}

/** Counts animation frames for `ms`, and samples how many chips the overlay drew in each. */
function measureFrames(page: Page, ms: number) {
  return page.evaluate((ms) => {
    const w = window as unknown as TrafficWindow;
    return new Promise<{ fps: number; intervals: number[]; chips: number[]; replies: number }>(
      (resolve) => {
        const intervals: number[] = [];
        const chips: number[] = [];
        const replies = w.perfLoad!.replies;
        const start = performance.now();
        let last = start;
        requestAnimationFrame(function tick(now) {
          intervals.push(now - last);
          last = now;
          chips.push(w.tracerTraffic.chips().length);
          if (now - start < ms) requestAnimationFrame(tick);
          else
            resolve({
              fps: (intervals.length * 1000) / (now - start),
              intervals,
              chips,
              replies: w.perfLoad!.replies - replies,
            });
        });
      },
    );
  }, ms);
}

type ProfileNode = {
  id: number;
  callFrame: { functionName: string; url: string; lineNumber: number };
};

/**
 * Samples the page's main thread. Profiling slows it, so a profiled run's frame rate is not one
 * to report; it says where the time goes. Returns the busy share and the top self-time functions.
 */
async function startProfile(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 250 });
  await cdp.send('Profiler.start');
  return async () => {
    const { profile } = await cdp.send('Profiler.stop');
    const nodes = new Map<number, ProfileNode>(
      (profile.nodes as ProfileNode[]).map((node) => [node.id, node]),
    );
    const self = new Map<string, number>();
    let total = 0;
    profile.samples!.forEach((id, index) => {
      const delta = profile.timeDeltas![index] ?? 0;
      const { functionName, url, lineNumber } = nodes.get(id)!.callFrame;
      const name = `${functionName || '(anonymous)'} ${url.split('/').pop()}:${lineNumber + 1}`;
      self.set(name, (self.get(name) ?? 0) + delta);
      total += delta;
    });
    const idle = [...self].find(([name]) => name.startsWith('(idle)'))?.[1] ?? 0;
    const top = [...self]
      .filter(([name]) => !name.startsWith('(idle)'))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([name, us]) => `${((100 * us) / total).toFixed(1)}% ${name}`);
    return { busyPercent: Number(((100 * (total - idle)) / total).toFixed(1)), top };
  };
}

const quantile = (values: number[], q: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
};

for (const rate of RATES) {
  for (let run = 1; run <= RUNS; run++) {
    test(`${rate} pings/s with traffic shown, run ${run}`, async ({ page }) => {
      await openRoutedLab(page);
      await page.waitForFunction(() => (window as Partial<TrafficWindow>).tracerTraffic);
      await page.keyboard.press('1');
      // PERF_TRAFFIC=off measures the same load with the overlay off, as a baseline.
      if (!SHOW_TRAFFIC) await page.getByRole('button', { name: 'Show traffic' }).click();
      await startLoad(page, rate);
      await page.waitForTimeout(WARMUP_MS);

      const profiler = process.env.PERF_PROFILE ? await startProfile(page) : undefined;
      const { fps, intervals, chips, replies } = await measureFrames(page, MEASURE_MS);
      if (profiler) console.log(`PROFILE ${JSON.stringify(await profiler())}`);
      const failures = await page.evaluate(() => {
        const w = window as unknown as TrafficWindow;
        w.perfLoad!.stop();
        return w.perfLoad!.failures;
      });
      const result = {
        rate,
        traffic: SHOW_TRAFFIC,
        run,
        fps: Number(fps.toFixed(1)),
        p50Ms: Number(quantile(intervals, 0.5).toFixed(1)),
        p95Ms: Number(quantile(intervals, 0.95).toFixed(1)),
        maxMs: Number(Math.max(...intervals).toFixed(1)),
        framesOver20Ms: intervals.filter((interval) => interval > 20).length,
        chipsMedian: quantile(chips, 0.5),
        chipsMax: Math.max(...chips),
        repliesPerSecond: Number(((replies * 1000) / MEASURE_MS).toFixed(1)),
        failures,
      };
      console.log(`PERF ${JSON.stringify(result)}`);

      // The work happened: the pings were answered and the overlay had chips to draw. Past about
      // 130 a second the page's own timer, which sends them, starts to fall behind.
      expect(failures).toBe(0);
      expect(result.repliesPerSecond).toBeGreaterThan(rate * 0.8);
      if (SHOW_TRAFFIC) expect(result.chipsMedian).toBeGreaterThan(0);
    });
  }
}
