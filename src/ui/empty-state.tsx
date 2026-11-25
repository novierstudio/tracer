import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from './cn';

type EmptyStateProps = {
  icon: LucideIcon;
  title: string;
  children: ReactNode;
  className?: string;
};

export function EmptyState({ icon: Icon, title, children, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center gap-3 px-6 py-8 text-center text-balance',
        className,
      )}
    >
      <span className="flex size-10 items-center justify-center rounded-lg border border-line bg-surface-2 text-fg-2">
        <Icon className="size-5" strokeWidth={1.75} />
      </span>
      <div className="flex max-w-64 flex-col gap-1">
        <p className="text-sm font-medium text-fg-1">{title}</p>
        <div className="text-xs text-fg-2">{children}</div>
      </div>
    </div>
  );
}
