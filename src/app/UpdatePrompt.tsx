import { RefreshCwIcon } from 'lucide-react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { fileSession } from '@/features/files/session';
import { Button } from '@/ui/button';

/**
 * Says when a new version of Tracer is ready. It never reloads by itself: the new version takes
 * over only when the user picks Reload, after the lab is written to storage.
 */
export function UpdatePrompt() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW();
  if (!needRefresh) return null;
  return (
    <div
      role="status"
      className="fixed bottom-10 left-1/2 z-50 flex w-max max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-3 rounded-lg bg-surface-1 py-2 pr-2 pl-3 text-sm text-fg-1 shadow-pop"
    >
      <RefreshCwIcon className="size-4 shrink-0 text-accent-text" />
      <p>A new version of Tracer is available.</p>
      <Button size="sm" variant="ghost" onClick={() => setNeedRefresh(false)}>
        Later
      </Button>
      <Button
        size="sm"
        variant="primary"
        onClick={async () => {
          await fileSession.flush();
          await updateServiceWorker(true);
        }}
      >
        Reload
      </Button>
    </div>
  );
}
