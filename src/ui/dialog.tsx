import { XIcon } from 'lucide-react';
import { Dialog as D } from 'radix-ui';
import type { ComponentProps, ReactNode } from 'react';
import { Button } from './button';
import { cn } from './cn';

export const Dialog = D.Root;
export const DialogTrigger = D.Trigger;
export const DialogClose = D.Close;

function Overlay() {
  return <D.Overlay className="fixed inset-0 z-40 animate-fade-in bg-black/40" />;
}

function CloseButton({ className }: { className?: string }) {
  return (
    <D.Close asChild>
      <Button variant="ghost" size="icon-sm" aria-label="Close" className={className}>
        <XIcon />
      </Button>
    </D.Close>
  );
}

type DialogContentProps = ComponentProps<typeof D.Content> & {
  title: string;
  description?: ReactNode;
};

export function DialogContent({
  title,
  description,
  className,
  children,
  ...props
}: DialogContentProps) {
  return (
    <D.Portal>
      <Overlay />
      <D.Content
        className={cn(
          'fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 animate-fade-in flex-col gap-4 overflow-y-auto rounded-xl bg-surface-1 p-5 text-fg-1 shadow-pop',
          className,
        )}
        {...(description ? {} : { 'aria-describedby': undefined })}
        {...props}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-1">
            <D.Title className="text-base font-semibold">{title}</D.Title>
            {description && (
              <D.Description className="text-sm text-fg-2">{description}</D.Description>
            )}
          </div>
          <CloseButton className="-mt-1 -mr-2" />
        </div>
        {children}
      </D.Content>
    </D.Portal>
  );
}

type SheetContentProps = ComponentProps<typeof D.Content> & {
  title: string;
  side: 'left' | 'right';
};

// A Sheet is a Dialog docked to one edge; narrow layouts show side panels this way.
export function SheetContent({ title, side, className, children, ...props }: SheetContentProps) {
  return (
    <D.Portal>
      <Overlay />
      <D.Content
        aria-describedby={undefined}
        className={cn(
          'fixed inset-y-0 z-50 flex w-[min(20rem,calc(100vw-3rem))] flex-col bg-surface-1 text-fg-1 shadow-pop',
          side === 'left' ? 'left-0 animate-slide-in-left' : 'right-0 animate-slide-in-right',
          className,
        )}
        {...props}
      >
        <D.Title className="sr-only">{title}</D.Title>
        <CloseButton className="absolute top-2 right-2 z-10" />
        {children}
      </D.Content>
    </D.Portal>
  );
}
