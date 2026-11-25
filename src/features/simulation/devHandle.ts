import type { SimClient } from '@/engine/client';

declare global {
  interface Window {
    /** Set before load (Playwright's `addInitScript`) to get the handle in a production build. */
    __TRACER_DEV__?: boolean;
    /** The simulation client, so devtools and e2e tests can ping and query devices. */
    tracerSim?: SimClient;
  }
}

export function exposeSimClient(client: SimClient) {
  if (import.meta.env.DEV || window.__TRACER_DEV__) window.tracerSim = client;
}
