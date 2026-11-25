import { lazy, Suspense } from 'react';
import type { DeviceId } from '@/model';
import { consoles } from './registry';

const XtermView = lazy(() => import('./XtermView'));

/** A router or switch's console. xterm loads on first open, outside the initial bundle. */
export function DeviceTerminal({ device, autoFocus }: { device: DeviceId; autoFocus: boolean }) {
  const tty = consoles.get(device);
  if (!tty) return null;
  return (
    <Suspense>
      <XtermView tty={tty} autoFocus={autoFocus} />
    </Suspense>
  );
}
