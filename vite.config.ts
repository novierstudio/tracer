import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { defineConfig, type Plugin } from 'vite';

const BASE = '/tracer/';

// The app's colours come from the design tokens, so the manifest and browser chrome match them.
const tokens = readFileSync(new URL('./src/ui/tokens.css', import.meta.url), 'utf8');
function token(theme: 'light' | 'dark', name: string): string {
  const block = tokens.split(theme === 'light' ? /^\.light \{/m : /^\.dark \{/m)[1] ?? '';
  const value = new RegExp(`--${name}:\\s*([^;]+);`).exec(block.split(/^\}/m)[0]!)?.[1];
  if (!value) throw new Error(`No --${name} token for the ${theme} theme in tokens.css`);
  return value;
}

// The colour of the top bar, so an installed app's title bar runs into it.
const themeColor = { light: token('light', 'surface-1'), dark: token('dark', 'surface-1') };

function themeColorMeta(): Plugin {
  return {
    name: 'tracer-theme-color',
    transformIndexHtml: () =>
      (['light', 'dark'] as const).map((theme) => ({
        tag: 'meta',
        attrs: {
          name: 'theme-color',
          media: `(prefers-color-scheme: ${theme})`,
          content: themeColor[theme],
        },
        injectTo: 'head',
      })),
  };
}

export default defineConfig({
  base: BASE,
  plugins: [
    react(),
    tailwindcss(),
    themeColorMeta(),
    VitePWA({
      // The app asks before it reloads into a new version, so a reload never drops work.
      registerType: 'prompt',
      injectRegister: false,
      manifest: {
        id: BASE,
        name: 'Tracer',
        short_name: 'Tracer',
        description: 'Build, configure and simulate computer networks in the browser.',
        start_url: BASE,
        scope: BASE,
        display: 'standalone',
        theme_color: themeColor.light,
        background_color: token('light', 'surface-0'),
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          {
            src: 'maskable-icon-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
        file_handlers: [
          {
            action: BASE,
            accept: {
              'application/json': ['.json'],
              'application/octet-stream': ['.pkt', '.pka'],
            },
          },
        ],
      },
      workbox: {
        // The app shell, every lazy chunk and worker, the fonts, the icons and the device sprites: all
        // of it works offline.
        globPatterns: ['**/*.{js,css,html,svg,png,webp,woff2}'],
        // The ELK layout chunk is about 1.5 MB.
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
      },
    }),
  ],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
});
