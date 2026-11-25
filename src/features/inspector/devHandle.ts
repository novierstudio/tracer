import { parseTopology } from '@/model';
import { editorStore } from '@/model/store';

declare global {
  interface Window {
    /** Set before load (Playwright's `addInitScript`) to get the handle in a production build. */
    __TRACER_DEV__?: boolean;
    /** Drives the editor from devtools and e2e tests until the canvas can select things. */
    tracer?: {
      editorStore: typeof editorStore;
      parseTopology: typeof parseTopology;
      /** Parses like opening a saved file, so schema defaults apply, then loads. Throws if invalid. */
      loadLab(input: unknown): void;
    };
  }
}

function loadLab(input: unknown): void {
  const parsed = parseTopology(input);
  if (!parsed.ok) throw new Error(parsed.error.message);
  editorStore.getState().load(parsed.value);
}

if (import.meta.env.DEV || window.__TRACER_DEV__) {
  window.tracer = { editorStore, parseTopology, loadLab };
}
