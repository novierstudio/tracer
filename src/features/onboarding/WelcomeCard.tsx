import {
  FileUpIcon,
  GripVerticalIcon,
  LayoutGridIcon,
  MousePointerClickIcon,
  PlusIcon,
  XIcon,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import iconUrl from '../../../assets/icon.svg';
import { formatShortcut } from '@/app/shell/shortcuts';
import { Button } from '@/ui/button';
import { cn } from '@/ui/cn';

type StartOption = {
  icon: LucideIcon;
  title: string;
  detail: string;
  onClick: () => void;
  featured?: boolean;
};

function StartTile({ icon: Icon, title, detail, onClick, featured }: StartOption) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group flex cursor-default flex-col items-start gap-2.5 rounded-xl border p-3.5 text-left transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-accent',
        featured
          ? 'border-accent/35 bg-accent/[0.06] hover:border-accent/60 hover:bg-accent/10'
          : 'border-line bg-surface-1 hover:border-line-strong hover:bg-surface-2',
      )}
    >
      <span
        className={cn(
          'flex size-8 items-center justify-center rounded-lg',
          featured ? 'bg-accent text-accent-fg' : 'bg-surface-2 text-fg-2 group-hover:text-fg-1',
        )}
      >
        <Icon className="size-4" strokeWidth={2} />
      </span>
      <span className="flex flex-col gap-0.5">
        <span className="text-sm font-medium text-fg-1">{title}</span>
        <span className="text-xs text-fg-2">{detail}</span>
      </span>
    </button>
  );
}

function Gesture({ hint, children }: { hint: ReactNode; children: ReactNode }) {
  return (
    <li className="flex items-center gap-3">
      <span className="flex size-6 shrink-0 items-center justify-center rounded-md border border-line bg-surface-2 text-2xs font-semibold text-fg-2 [&_svg]:size-3.5">
        {hint}
      </span>
      <span>{children}</span>
    </li>
  );
}

type WelcomeCardProps = {
  onStartBlank: () => void;
  onOpenSamples: () => void;
  onImport: () => void;
  onDismiss: () => void;
};

/** Three ways to start and the three gestures that build a lab. Calm, small, and easy to close. */
export function WelcomeCard({
  onStartBlank,
  onOpenSamples,
  onImport,
  onDismiss,
}: WelcomeCardProps) {
  return (
    <section
      aria-labelledby="welcome-title"
      className="pointer-events-auto relative max-h-full w-[min(40rem,100%)] animate-fade-in overflow-y-auto rounded-2xl bg-surface-1 p-6 shadow-pop"
    >
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Close welcome"
        className="absolute top-3 right-3"
        onClick={onDismiss}
      >
        <XIcon />
      </Button>
      <div className="flex items-center gap-3 pr-8">
        <img src={iconUrl} alt="" className="size-9 rounded-[9px]" />
        <div className="flex flex-col">
          <h2 id="welcome-title" className="text-base font-semibold text-fg-1">
            Welcome to Tracer
          </h2>
          <p className="text-sm text-fg-2">
            Build a network, open a console, and watch the packets move.
          </p>
        </div>
      </div>

      <div className="mt-5 grid gap-2 @lg:grid-cols-3">
        <StartTile
          icon={PlusIcon}
          title="Start blank"
          detail="An empty canvas for your own network"
          onClick={onStartBlank}
        />
        <StartTile
          icon={LayoutGridIcon}
          title="Open a sample lab"
          detail="Working networks, ready to ping"
          onClick={onOpenSamples}
          featured
        />
        <StartTile
          icon={FileUpIcon}
          title="Import a .pkt file"
          detail="Bring a lab from Packet Tracer"
          onClick={onImport}
        />
      </div>

      <div className="mt-5 border-t border-line pt-4">
        <h3 className="text-2xs font-medium tracking-wide text-fg-3 uppercase">How to build</h3>
        <ul className="mt-3 flex flex-col gap-2.5 text-sm text-fg-2">
          <Gesture hint={<GripVerticalIcon strokeWidth={2} />}>
            Drag a device from the palette onto the canvas
          </Gesture>
          <Gesture hint={formatShortcut('cableTool')}>
            Press {formatShortcut('cableTool')}, then click two devices to cable them
          </Gesture>
          <Gesture hint={<MousePointerClickIcon strokeWidth={2} />}>
            Double-click a device to open its CLI or Desktop
          </Gesture>
        </ul>
      </div>
    </section>
  );
}
