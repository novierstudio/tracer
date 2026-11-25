import { Tooltip as T } from 'radix-ui';
import type { ReactNode } from 'react';
import { Kbd } from './kbd';

export const TooltipProvider = T.Provider;

type TooltipProps = {
  label: string;
  shortcut?: string | undefined;
  side?: T.TooltipContentProps['side'];
  children: ReactNode;
};

export function Tooltip({ label, shortcut, side = 'bottom', children }: TooltipProps) {
  return (
    <T.Root>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content
          side={side}
          sideOffset={6}
          className="z-50 flex animate-fade-in items-center gap-2 rounded-md bg-fg-1 px-2 py-1 text-xs font-medium text-surface-1 shadow-pop"
        >
          {label}
          {shortcut && (
            <Kbd className="border-transparent bg-surface-1/15 text-surface-1">{shortcut}</Kbd>
          )}
        </T.Content>
      </T.Portal>
    </T.Root>
  );
}
