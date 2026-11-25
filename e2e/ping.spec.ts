import { expect, test, type Page } from '@playwright/test';
import { openRoutedLab as openLab, type DevWindow, type PingEvent } from './routed';

test.use({ viewport: { width: 1440, height: 900 } });

const lights = (page: Page, cable: RegExp) =>
  page.getByRole('group', { name: cable }).locator('.link-light');

test('pings PC2 from PC1 across a router through the simulation worker', async ({ page }) => {
  await openLab(page);

  const events = await page.evaluate(
    () =>
      new Promise<PingEvent[]>((resolve, reject) => {
        const events: PingEvent[] = [];
        const options = { count: 4, timeoutMs: 1000 };
        void (window as unknown as DevWindow).tracerSim
          .ping('dev_PC1', '192.168.2.10', options, (event) => {
            events.push(event);
            if (event.kind === 'summary') resolve(events);
          })
          .then((started) => {
            if (!started.ok) reject(new Error(`ping did not start: ${started.error}`));
          });
      }),
  );

  expect(events.slice(0, 4)).toEqual(
    [1, 2, 3, 4].map((seq) =>
      expect.objectContaining({ kind: 'reply', seq, from: '192.168.2.10', ttl: 127 }),
    ),
  );
  expect(events[4]).toMatchObject({ kind: 'summary', sent: 4, received: 4 });
});

test("lights every link green, and shutting a port turns that link's lights red", async ({
  page,
}) => {
  await openLab(page);
  const r1ToSw2 = /^Straight-through cable from R1 Gi0\/1 to SW2 Gi0\/1$/;
  await expect(page.locator('.link-light[data-state="up"]')).toHaveCount(8);

  await page.evaluate(() => {
    const store = (window as unknown as DevWindow).tracer.editorStore.getState();
    const config = store.topology.devices['dev_R1']!.config as {
      interfaces: Record<string, { shutdown: boolean }>;
    };
    const gi01 = { ...config.interfaces['GigabitEthernet0/1']!, shutdown: true };
    store.updateConfig({
      device: 'dev_R1',
      kind: 'router',
      config: { ...config, interfaces: { ...config.interfaces, 'GigabitEthernet0/1': gi01 } },
    });
  });

  await expect(lights(page, r1ToSw2)).toHaveCount(2);
  for (const light of await lights(page, r1ToSw2).all()) {
    await expect(light).toHaveAttribute('data-state', 'down');
  }
  await expect(page.locator('.link-light[data-state="up"]')).toHaveCount(6);
});
