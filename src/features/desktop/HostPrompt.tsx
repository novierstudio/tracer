import { lazy, Suspense } from 'react';
import type { DeviceId } from '@/model';
import { hostPrompts } from './registry';

const XtermView = lazy(() => import('@/features/terminal/XtermView'));

const HINT =
  'A host command prompt. Type help for the commands. Up and Down recall earlier lines, Ctrl+C stops a running ping, and Shift+Tab leaves the terminal.';

/** A PC or server's Command Prompt. Every view of one host shows the same session. */
export function HostPrompt({ device, autoFocus }: { device: DeviceId; autoFocus: boolean }) {
  const tty = hostPrompts.get(device);
  if (!tty) return null;
  return (
    <Suspense>
      <XtermView tty={tty} autoFocus={autoFocus} hint={HINT} />
    </Suspense>
  );
}
