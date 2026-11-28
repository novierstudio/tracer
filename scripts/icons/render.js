// Renders the isometric device sprites in Playwright's Chromium and writes them to
// public/devices/<name>.webp (96 px) and <name>@2x.webp (192 px). Run `pnpm icons:render` after
// changing a model in scripts/icons/models/, and commit the sprites.
//
//   pnpm icons:render                      every model
//   pnpm icons:render --only router,pc     some of them
//   pnpm icons:render --sheet sheet.png    also a contact sheet at real size, light and dark
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from '@playwright/test';

const root = new URL('../../', import.meta.url);
const here = new URL('./', import.meta.url);
const out = new URL('public/devices/', root);
const SIZES = [
  { size: 96, suffix: '' },
  { size: 192, suffix: '@2x' },
];
const ORIGIN = 'http://sprites.local';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript' };

const { values } = parseArgs({
  options: { only: { type: 'string' }, sheet: { type: 'string' } },
});

const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage();
  page.on('pageerror', (error) => console.error(error));
  // Serve the page, the models and three.js straight from disk.
  await page.route(`${ORIGIN}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    const file = path.startsWith('/three/')
      ? new URL(`node_modules${path}`, root)
      : new URL(`.${path}`, here);
    try {
      const body = await readFile(file);
      await route.fulfill({ body, contentType: TYPES[extname(path)] ?? 'text/plain' });
    } catch {
      await route.fulfill({ status: 404 });
    }
  });
  await page.goto(`${ORIGIN}/page.html`);
  await page.waitForFunction(() => window.spritesReady, null, { timeout: 30_000 });
  const all = await page.evaluate(() => window.spriteNames);
  const names = values.only ? values.only.split(',') : all;
  const unknown = names.filter((name) => !all.includes(name));
  if (unknown.length) throw new Error(`No model for ${unknown.join(', ')}`);

  await mkdir(out, { recursive: true });
  const crowded = [];
  for (const name of names) {
    for (const { size, suffix } of SIZES) {
      const { dataUrl, fill } = await page.evaluate(
        ([name, size]) => window.renderSprite(name, size),
        [name, size],
      );
      if (!dataUrl.startsWith('data:image/webp'))
        throw new Error('This Chromium cannot encode WebP');
      const bytes = Buffer.from(dataUrl.split(',')[1], 'base64');
      await writeFile(new URL(`${name}${suffix}.webp`, out), bytes);
      if (suffix === '') {
        console.log(
          `${name.padEnd(20)} ${String(bytes.length).padStart(6)} B  fill ${fill.toFixed(2)}`,
        );
        if (fill > 0.96) crowded.push(name);
      }
    }
  }
  if (values.sheet) await contactSheet(browser, all, values.sheet);
  // A model that overflows its size class would be clipped at the sprite's edge.
  if (crowded.length) throw new Error(`Too big for their size class: ${crowded.join(', ')}`);
} finally {
  await browser.close();
}

/** Every sprite at 64 and 48 px on the light and dark canvas, as the app draws it at 1x. */
async function contactSheet(browser, names, path) {
  const sources = {};
  for (const name of names) {
    const [one, two] = await Promise.all(
      SIZES.map(({ suffix }) => readFile(new URL(`${name}${suffix}.webp`, out), 'base64')),
    );
    sources[name] = `data:image/webp;base64,${one} 1x, data:image/webp;base64,${two} 2x`;
  }
  const theme = (background, text) => `
    <section style="background:${background};color:${text};padding:12px;display:grid;grid-template-columns:repeat(11,84px);gap:6px 4px">
      ${names
        .map(
          (
            name,
          ) => `<figure style="margin:0;display:flex;flex-direction:column;align-items:center;gap:2px">
            <img srcset="${sources[name]}" width="64" height="64">
            <img srcset="${sources[name]}" width="48" height="48">
            <figcaption style="font:10px system-ui;opacity:.75">${name}</figcaption></figure>`,
        )
        .join('')}
    </section>`;
  const page = await browser.newPage({ viewport: { width: 980, height: 600 } });
  await page.setContent(
    `<body style="margin:0">${theme('#f6f6f7', '#18181b')}${theme('#0c0c0e', '#ededf0')}</body>`,
  );
  await page.waitForFunction(() => [...document.images].every((image) => image.complete));
  await page.screenshot({ path, fullPage: true });
  console.log(`Contact sheet: ${path}`);
}
