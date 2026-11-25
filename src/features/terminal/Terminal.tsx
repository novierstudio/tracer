import { lazy, Suspense } from 'react';

const DemoXterm = lazy(() => import('./XtermView'));

/** The global demo router CLI. xterm loads on first open, outside the initial bundle. */
export function DemoTerminal({ autoFocus }: { autoFocus: boolean }) {
  return (
    <Suspense>
      <DemoXterm autoFocus={autoFocus} />
    </Suspense>
  );
}
