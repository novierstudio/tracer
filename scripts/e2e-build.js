// Builds the app for the e2e suite. The build goes to a folder of its own and replaces dist/ only
// once it is complete, so a build killed partway, as by the webServer timeout, never leaves a
// dist/ that has the app's assets but not its service worker.
import { execFileSync } from 'node:child_process';
import { existsSync, renameSync, rmSync } from 'node:fs';

const staging = `dist-e2e-${process.pid}`;
try {
  execFileSync('pnpm', ['exec', 'vite', 'build', '--outDir', staging], { stdio: 'inherit' });
  if (!existsSync(`${staging}/sw.js`)) {
    throw new Error(
      `The build wrote no service worker to ${staging}/sw.js, so pwa.spec.ts would fail`,
    );
  }
  rmSync('dist', { recursive: true, force: true });
  renameSync(staging, 'dist');
} finally {
  rmSync(staging, { recursive: true, force: true });
}
