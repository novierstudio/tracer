import type { ComponentProps } from 'react';
import { cn } from './cn';

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return (
    <input
      className={cn(
        'h-8 w-full min-w-0 rounded-md border border-line bg-surface-1 px-2.5 text-sm text-fg-1 transition-colors outline-none placeholder:text-fg-3 hover:border-line-strong focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/25 disabled:pointer-events-none disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}
