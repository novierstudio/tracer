import { parseTopology } from '@/model';
import { editorStore } from '@/model/store';

declare global {
  interface Window {
    /** Set before load (Playwright's `addInitScript`) to get the handle in a production build. */
    __TRACER_DEV__?: boolean;
    /** Drives the editor from devtools and e2e tests until the canvas can select things. */
    tracer?: { editorStore: typeof editorStore; parseTopology: typeof parseTopology };
  }
}

if (import.meta.env.DEV || window.__TRACER_DEV__) window.tracer = { editorStore, parseTopology };
