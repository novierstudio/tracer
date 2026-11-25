import { expect, test } from '@playwright/test';

test('the simulation worker boots from the /tracer/ base and streams its first batch', async ({
  page,
}) => {
  const workers: string[] = [];
  page.on('worker', (worker) => workers.push(new URL(worker.url()).pathname));
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  await page.goto('./');

  await expect(page.getByRole('contentinfo').getByRole('status')).toHaveText('Engine ready');
  expect(workers).toEqual([expect.stringMatching(/^\/tracer\/assets\/sim\.worker-[\w-]+\.js$/)]);
  expect(errors).toEqual([]);
});
