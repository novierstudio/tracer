import { CheckIcon, ChevronRightIcon } from 'lucide-react';
import { ContextMenu as M } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from './cn';

// Styled like the dropdown menu, so right-click menus and top-bar menus read as one family.

export const ContextMenu = M.Root;
export const ContextMenuTrigger = M.Trigger;
export const ContextMenuSub = M.Sub;
export const ContextMenuRadioGroup = M.RadioGroup;

const contentClass =
  'z-50 min-w-48 animate-fade-in rounded-lg border border-line bg-surface-1 p-1 text-sm text-fg-1 shadow-pop';

export function ContextMenuContent({ className, ...props }: ComponentProps<typeof M.Content>) {
  return (
    <M.Portal>
      <M.Content collisionPadding={8} className={cn(contentClass, className)} {...props} />
    </M.Portal>
  );
}

export function ContextMenuSubContent({
  className,
  ...props
}: ComponentProps<typeof M.SubContent>) {
  return (
    <M.Portal>
      <M.SubContent
        sideOffset={6}
        collisionPadding={8}
        className={cn(contentClass, className)}
        {...props}
      />
    </M.Portal>
  );
}

const itemClass =
  'relative flex h-8 cursor-default items-center gap-2 rounded-md px-2 outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:text-fg-3 data-[highlighted]:bg-surface-2 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-fg-2 data-[disabled]:[&_svg]:text-fg-3';

type ItemProps = ComponentProps<typeof M.Item> & { destructive?: boolean };

export function ContextMenuItem({ className, destructive, ...props }: ItemProps) {
  return (
    <M.Item
      className={cn(
        itemClass,
        destructive && 'text-err data-[highlighted]:bg-err/10 [&_svg]:text-err',
        className,
      )}
      {...props}
    />
  );
}

export function ContextMenuSubTrigger({
  className,
  children,
  ...props
}: ComponentProps<typeof M.SubTrigger>) {
  return (
    <M.SubTrigger className={cn(itemClass, 'data-[state=open]:bg-surface-2', className)} {...props}>
      {children}
      <ChevronRightIcon className="ml-auto" />
    </M.SubTrigger>
  );
}

export function ContextMenuRadioItem({
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

export function ContextMenuSeparator({ className, ...props }: ComponentProps<typeof M.Separator>) {
  return <M.Separator className={cn('-mx-1 my-1 h-px bg-line', className)} {...props} />;
}

export function ContextMenuShortcut({ className, ...props }: ComponentProps<'span'>) {
  return <span className={cn('ml-auto pl-6 text-xs text-fg-3', className)} {...props} />;
}
