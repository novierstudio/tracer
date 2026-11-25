// Renders the PNG icons the web app manifest and iOS need from assets/icon.svg, in Playwright's
// Chromium. Run `pnpm icons` after changing the icon, and commit the PNGs in public/.
import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const root = new URL('../', import.meta.url);
const icon = await readFile(new URL('assets/icon.svg', root), 'utf8');
const fill = /fill="(#[0-9a-f]{6})"/i.exec(icon)?.[1];
if (!fill) throw new Error('assets/icon.svg has no background fill');

const iconUrl = `data:image/svg+xml;base64,${Buffer.from(icon).toString('base64')}`;
// `any` icons keep the rounded square. Maskable and iOS icons fill the square with the icon's
// background and keep the mark inside the 80% safe zone, because the platform crops the corners.
const ICONS = [
  { file: 'pwa-192x192.png', size: 192, inset: 0 },
  { file: 'pwa-512x512.png', size: 512, inset: 0 },
  { file: 'maskable-icon-512x512.png', size: 512, inset: 0.1, bleed: true },
  { file: 'apple-touch-icon-180x180.png', size: 180, inset: 0.06, bleed: true },
];

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  for (const { file, size, inset, bleed } of ICONS) {
    await page.setViewportSize({ width: size, height: size });
    const pad = size * inset;
    await page.setContent(
      `<body style="margin:0;background:${bleed ? fill : 'transparent'}">` +
        `<img src="${iconUrl}" style="display:block;margin:${pad}px;width:${size - 2 * pad}px;height:${size - 2 * pad}px">`,
    );
    const png = await page.screenshot({ omitBackground: !bleed });
    await writeFile(new URL(`public/${file}`, root), png);
    console.log(`public/${file}`);
  }
} finally {
  await browser.close();
}
