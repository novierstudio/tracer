import { ArrowRightIcon, LoaderCircleIcon } from 'lucide-react';
import { useState } from 'react';
import type { DeviceIconName } from '@/devices/catalog';
import { DeviceIcon } from '@/devices/icons';
import {
  DIFFICULTY_LABELS,
  SAMPLE_LABS,
  deviceCount,
  type Difficulty,
  type SampleLab,
} from '@/labs/catalog';
import type { DeviceKind } from '@/model';
import { cn } from '@/ui/cn';
import { Dialog, DialogContent } from '@/ui/dialog';
import { openSample } from './openSample';

const ICON: Record<DeviceKind, DeviceIconName> = {
  router: 'router',
  switch: 'switch',
  pc: 'pc',
  server: 'server',
};

const DIFFICULTY_STYLE: Record<Difficulty, string> = {
  beginner: 'bg-ok/10 text-ok',
  intermediate: 'bg-accent/10 text-accent-text',
};

function LabCard({
  lab,
  opening,
  onOpen,
}: {
  lab: SampleLab;
  opening: boolean;
  onOpen: () => void;
}) {
  const count = deviceCount(lab);
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        aria-busy={opening}
        className="group flex h-full w-full cursor-default flex-col gap-3 rounded-xl border border-line bg-surface-1 p-4 text-left transition-colors duration-150 outline-none hover:border-line-strong hover:bg-surface-2/60 focus-visible:ring-2 focus-visible:ring-accent"
      >
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-2.5" aria-hidden>
            {(Object.entries(lab.devices) as [DeviceKind, number][]).map(([kind, n]) => (
              <span key={kind} className="flex items-center gap-1 text-2xs text-fg-3 tabular-nums">
                <DeviceIcon name={ICON[kind]} className="size-6 text-fg-2" />
                {n > 1 && `×${n}`}
              </span>
            ))}
          </span>
          <span
            className={cn(
              'rounded-full px-2 py-0.5 text-2xs font-medium',
              DIFFICULTY_STYLE[lab.difficulty],
            )}
          >
            {DIFFICULTY_LABELS[lab.difficulty]}
          </span>
        </div>
        <div className="flex flex-col gap-1">
          <h3 className="text-sm font-semibold text-fg-1">{lab.title}</h3>
          <p className="text-xs leading-relaxed text-fg-2">{lab.description}</p>
        </div>
        <div className="mt-auto flex items-center justify-between pt-1 text-xs">
          <span className="text-fg-3">{count === 1 ? '1 device' : `${count} devices`}</span>
          <span className="flex items-center gap-1 font-medium text-accent-text opacity-80 transition-opacity group-hover:opacity-100">
            {opening ? (
              <>
                <LoaderCircleIcon className="size-3.5 animate-spin" />
                Opening
              </>
            ) : (
              <>
                Open
                <ArrowRightIcon className="size-3.5 transition-transform group-hover:translate-x-0.5" />
              </>
            )}
          </span>
        </div>
      </button>
    </li>
  );
}

type SampleGalleryProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Tests pass their own; the app opens the lab through the file session. */
  onOpenLab?: (lab: SampleLab) => Promise<void>;
};

export default function SampleGallery({
  open,
  onOpenChange,
  onOpenLab = openSample,
}: SampleGalleryProps) {
  const [opening, setOpening] = useState<string | null>(null);
  const openLab = async (lab: SampleLab) => {
    if (opening) return;
    setOpening(lab.id);
    try {
      await onOpenLab(lab);
    } finally {
      setOpening(null);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Sample labs"
        description="Working networks to explore and break. The lab you have open stays in Recent labs."
        className="sm:max-w-3xl"
      >
        <ul aria-label="Sample labs" className="grid gap-3 sm:grid-cols-2">
          {SAMPLE_LABS.map((lab) => (
            <LabCard
              key={lab.id}
              lab={lab}
              opening={opening === lab.id}
              onOpen={() => void openLab(lab)}
            />
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
