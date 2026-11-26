import type { HTMLAttributes } from 'react';
import { cn } from '@/ui/cn';

/** A labelled monospace input for addresses, with its error underneath. */
export function Field({
  id,
  label,
  value,
  error,
  placeholder,
  autoFocus,
  inputMode = 'decimal',
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  error: string | undefined;
  placeholder?: string;
  autoFocus?: boolean;
  /** The on-screen keyboard to offer: digits and dots by default, for IPv4. */
  inputMode?: HTMLAttributes<HTMLInputElement>['inputMode'];
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-2xs text-fg-3">
        {label}
      </label>
      <input
        id={id}
        value={value}
        placeholder={placeholder}
        autoFocus={autoFocus}
        spellCheck={false}
        autoComplete="off"
        inputMode={inputMode}
        aria-invalid={error !== undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        onChange={(event) => onChange(event.target.value)}
        className={cn(
          'h-7 w-full min-w-0 rounded-md border border-line bg-surface-1 px-2 font-mono text-[0.6875rem] text-fg-1 tabular-nums transition-colors outline-none placeholder:text-fg-3/70 hover:border-line-strong focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/25',
          error &&
            'border-err/70 hover:border-err focus-visible:border-err focus-visible:ring-err/20',
        )}
      />
      {error && (
        <p id={`${id}-error`} className="text-2xs text-err">
          {error}
        </p>
      )}
    </div>
  );
}
