import { useState } from 'react';
import { Hostname, type Device } from '@/model';
import { editorStore } from '@/model/store';
import { cn } from '@/ui/cn';

/**
 * Renames on Enter or blur. Escape reverts. An invalid name stays in the field with the model's
 * error until it is fixed or reverted; nothing reaches the store, so undo only sees real renames.
 */
export function HostnameField({
  device,
  error,
  errorId,
  onError,
}: {
  device: Device;
  error: string | null;
  /** The parent renders the error full width under the header; the input points at it. */
  errorId: string;
  onError: (error: string | null) => void;
}) {
  const current = device.config.hostname;
  // null while not editing, so undo/redo and renames from elsewhere show through.
  const [draft, setDraft] = useState<string | null>(null);

  const commit = () => {
    if (draft === null) return;
    const parsed = Hostname.safeParse(draft.trim());
    if (!parsed.success) {
      onError(parsed.error.issues[0]?.message ?? 'Invalid hostname');
      return;
    }
    if (parsed.data !== current) {
      editorStore.getState().renameDevice({ device: device.id, hostname: parsed.data });
    }
    setDraft(null);
    onError(null);
  };

  const revert = () => {
    setDraft(null);
    onError(null);
  };

  return (
    <input
      aria-label="Hostname"
      aria-invalid={error !== null}
      aria-describedby={error ? errorId : undefined}
      spellCheck={false}
      autoComplete="off"
      value={draft ?? current}
      onChange={(event) => {
        setDraft(event.target.value);
        if (error) onError(null);
      }}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          commit();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          revert();
        }
      }}
      className={cn(
        '-mx-1.5 h-7 w-full min-w-0 rounded-md border border-transparent bg-transparent px-1.5 text-base font-semibold text-fg-1 transition-colors outline-none hover:border-line focus-visible:border-accent focus-visible:bg-surface-1 focus-visible:ring-2 focus-visible:ring-accent/25',
        error &&
          'border-err/70 hover:border-err focus-visible:border-err focus-visible:ring-err/20',
      )}
    />
  );
}
