import { CheckIcon } from 'lucide-react';
import { DropdownMenu as M } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from './cn';

export const DropdownMenu = M.Root;
export const DropdownMenuTrigger = M.Trigger;
export const DropdownMenuRadioGroup = M.RadioGroup;

export function DropdownMenuContent({
  className,
  sideOffset = 6,
  ...props
}: ComponentProps<typeof M.Content>) {
  return (
    <M.Portal>
      <M.Content
        sideOffset={sideOffset}
        className={cn(
          'z-50 min-w-44 animate-fade-in rounded-lg bg-surface-1 p-1 text-sm text-fg-1 shadow-pop',
          className,
        )}
        {...props}
      />
    </M.Portal>
  );
}

const itemClass =
  'relative flex h-8 cursor-default items-center gap-2 rounded-md px-2 outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:text-fg-3 data-[highlighted]:bg-surface-2 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-fg-2 data-[disabled]:[&_svg]:text-fg-3';

export function DropdownMenuItem({ className, ...props }: ComponentProps<typeof M.Item>) {
  return <M.Item className={cn(itemClass, className)} {...props} />;
}

export function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: ComponentProps<typeof M.RadioItem>) {
  return (
    <M.RadioItem className={cn(itemClass, 'pr-8', className)} {...props}>
      {children}
      <M.ItemIndicator className="absolute right-2 flex items-center">
        <CheckIcon />
      </M.ItemIndicator>
    </M.RadioItem>
  );
}

export function DropdownMenuLabel({ className, ...props }: ComponentProps<typeof M.Label>) {
  return (
    <M.Label
      className={cn('px-2 pt-1.5 pb-1 text-xs font-medium text-fg-3', className)}
      {...props}
    />
  );
}

export function DropdownMenuSeparator({ className, ...props }: ComponentProps<typeof M.Separator>) {
  return <M.Separator className={cn('-mx-1 my-1 h-px bg-line', className)} {...props} />;
}

export function DropdownMenuShortcut({ className, ...props }: ComponentProps<'span'>) {
  return <span className={cn('ml-auto pl-4 text-xs text-fg-3', className)} {...props} />;
}
