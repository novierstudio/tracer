import { Tabs as T } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from './cn';

export const Tabs = T.Root;

export function TabsList({ className, ...props }: ComponentProps<typeof T.List>) {
  return <T.List className={cn('flex items-center gap-1', className)} {...props} />;
}

export function TabsTrigger({ className, ...props }: ComponentProps<typeof T.Trigger>) {
  return (
    <T.Trigger
      className={cn(
        "inline-flex h-7 cursor-default items-center gap-1.5 rounded-md px-2 text-xs font-medium text-fg-2 transition-colors duration-150 select-none hover:text-fg-1 data-[state=active]:bg-surface-2 data-[state=active]:text-fg-1 [&_svg:not([class*='size-'])]:size-3.5",
        className,
      )}
      {...props}
    />
  );
}

export function TabsContent({ className, ...props }: ComponentProps<typeof T.Content>) {
  return <T.Content className={cn('min-h-0 flex-1 outline-none', className)} {...props} />;
}
