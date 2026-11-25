import { NetworkIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/ui/cn';
import { EmptyState } from '@/ui/empty-state';

type CanvasPlaceholderProps = { fullscreen: boolean; children?: ReactNode };

export function CanvasPlaceholder({ fullscreen, children }: CanvasPlaceholderProps) {
  return (
    <main
      aria-label="Canvas"
      className={cn(
        'flex items-center justify-center overflow-hidden bg-surface-0 bg-[radial-gradient(var(--grid-dot)_1px,transparent_1px)] bg-size-[16px_16px]',
        fullscreen ? 'fixed inset-0 z-30' : 'relative h-full',
      )}
    >
      <EmptyState
        icon={NetworkIcon}
        title="Your lab is empty"
        className="rounded-xl bg-surface-0/80 backdrop-blur-[2px]"
      >
        This is where you&apos;ll build and run your network. Placing and wiring devices arrives
        with the canvas in the next milestone.
      </EmptyState>
      {children}
    </main>
  );
}
