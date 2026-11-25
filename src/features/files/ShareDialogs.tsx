import { CheckIcon, Link2Icon, XIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useStore } from 'zustand';
import { Button } from '@/ui/button';
import { Dialog, DialogClose, DialogContent } from '@/ui/dialog';
import { Segmented } from '@/ui/segmented';
import { Tooltip } from '@/ui/tooltip';
import type { ImageBackground, ImageFormat } from './exportImage';
import {
  chooseImage,
  copyShareLink,
  dismissCopied,
  dismissSharedLab,
  exportImage,
  LONG_LINK_CHARS,
  openSharedLab,
  readShareLink,
  sharing,
  type SharingState,
} from './sharing';

const useSharing = <T,>(selector: (state: SharingState) => T) => useStore(sharing, selector);

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

function SharedLabDialog() {
  const lab = useSharing((state) => state.sharedLab);
  return (
    <Dialog open={!!lab} onOpenChange={(open) => !open && dismissSharedLab()}>
      {lab && (
        <DialogContent
          title={`Open “${lab.meta.name}”?`}
          description={`This link holds a lab with ${plural(Object.keys(lab.devices).length, 'device')} and ${plural(Object.keys(lab.links).length, 'cable')}. It opens as a new lab, and the lab you have open stays under Recent labs.`}
        >
          <div className="flex justify-end gap-2">
            <DialogClose asChild>
              <Button>Not now</Button>
            </DialogClose>
            <Button variant="primary" onClick={() => void openSharedLab()}>
              Open lab
            </Button>
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}

const FORMATS = [
  { value: 'png', label: 'PNG' },
  { value: 'svg', label: 'SVG' },
] as const;
const BACKGROUNDS = [
  { value: 'theme', label: 'Theme' },
  { value: 'transparent', label: 'Transparent' },
] as const;

function ExportImageDialog() {
  const open = useSharing((state) => state.choosingImage);
  const [format, setFormat] = useState<ImageFormat>('png');
  const [background, setBackground] = useState<ImageBackground>('theme');
  return (
    <Dialog open={open} onOpenChange={chooseImage}>
      <DialogContent
        title="Export image"
        description="A picture of the whole lab, devices, cables and notes, in the current theme. PNG is at 2× for sharp slides and documents."
      >
        <div className="grid grid-cols-[auto_1fr] items-center justify-items-start gap-x-4 gap-y-3 text-sm">
          <span className="text-fg-2">Format</span>
          <Segmented label="Format" value={format} onValueChange={setFormat} options={FORMATS} />
          <span className="text-fg-2">Background</span>
          <Segmented
            label="Background"
            value={background}
            onValueChange={setBackground}
            options={BACKGROUNDS}
          />
        </div>
        <div className="flex justify-end gap-2">
          <DialogClose asChild>
            <Button>Cancel</Button>
          </DialogClose>
          <Button
            variant="primary"
            onClick={() => {
              chooseImage(false);
              void exportImage(format, background);
            }}
          >
            Export
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

const COPIED_TOAST_MS = 3000;

function CopiedToast() {
  const length = useSharing((state) => state.copiedLength);
  const long = length !== undefined && length > LONG_LINK_CHARS;
  useEffect(() => {
    if (length === undefined || long) return;
    const timer = setTimeout(dismissCopied, COPIED_TOAST_MS);
    return () => clearTimeout(timer);
  }, [length, long]);
  if (length === undefined) return null;
  return (
    <div
      role="status"
      className="fixed right-4 bottom-10 z-40 flex max-w-sm items-start gap-2 rounded-lg bg-surface-1 p-3 text-sm text-fg-1 shadow-pop"
    >
      <CheckIcon className="mt-0.5 size-4 shrink-0 text-ok" />
      <p className="flex-1">
        Share link copied.
        {long &&
          ` At ${Math.round(length / 1000)}k characters it is long, and some chat apps and email clients cut long links off. For a lab this size, share the .tracer.json file instead.`}
      </p>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Dismiss"
        className="-mt-1 -mr-1"
        onClick={dismissCopied}
      >
        <XIcon />
      </Button>
    </div>
  );
}

/** Copies a link that opens this lab, for the top bar. */
export function ShareButton() {
  return (
    <Tooltip label="Copy share link">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Copy share link"
        onClick={() => void copyShareLink()}
      >
        <Link2Icon />
      </Button>
    </Tooltip>
  );
}

/** Offers the lab in a share link, now and whenever one is pasted into the address bar. */
export function ShareDialogs() {
  useEffect(() => {
    const read = () => void readShareLink();
    read();
    window.addEventListener('hashchange', read);
    return () => window.removeEventListener('hashchange', read);
  }, []);
  return (
    <>
      <SharedLabDialog />
      <ExportImageDialog />
      <CopiedToast />
    </>
  );
}
