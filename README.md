<img src="assets/icon.svg" width="64" height="64" alt="">

# Tracer

Tracer is a network simulator that runs in the browser. It aims to be a better-looking alternative to Cisco Packet Tracer that can open existing `.pkt` files.

Live site: https://novierstudio.github.io/tracer/

Tracer is in early development. The current build is a placeholder.

## Development

You need Node 22 (see `.nvmrc`) and pnpm. Corepack or pnpm reads the pinned version from `packageManager` in `package.json`.

```sh
pnpm install
pnpm dev          # start the dev server at http://localhost:5173/tracer/
pnpm build        # build to dist/
pnpm preview      # serve the built app
pnpm typecheck
pnpm lint
pnpm format
pnpm test         # unit tests (Vitest)
pnpm test:e2e     # browser smoke test (Playwright)
```

Before the first `pnpm test:e2e`, install the browser with `pnpm exec playwright install chromium`.

## Disclaimer

Tracer is an independent project. It is not affiliated with or endorsed by Cisco Systems. Cisco and Packet Tracer are trademarks of Cisco Systems, Inc.
