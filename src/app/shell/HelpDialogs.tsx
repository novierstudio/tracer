import { Dialog, DialogContent } from '@/ui/dialog';
import { Kbd } from '@/ui/kbd';
import { SHORTCUTS, formatShortcut, type ShortcutId } from './shortcuts';

export type HelpDialog = 'shortcuts' | 'about';

type HelpDialogsProps = {
  open: HelpDialog | null;
  onOpenChange: (open: HelpDialog | null) => void;
};

export function HelpDialogs({ open, onOpenChange }: HelpDialogsProps) {
  const close = (next: boolean) => {
    if (!next) onOpenChange(null);
  };
  return (
    <>
      <Dialog open={open === 'shortcuts'} onOpenChange={close}>
        <DialogContent title="Keyboard shortcuts">
          <ul className="flex flex-col">
            {(Object.keys(SHORTCUTS) as ShortcutId[]).map((id) => (
              <li
                key={id}
                className="flex h-9 items-center justify-between border-b border-line last:border-0"
              >
                <span className="text-fg-2">{SHORTCUTS[id].label}</span>
                <Kbd>{formatShortcut(id)}</Kbd>
              </li>
            ))}
            <li className="flex h-9 items-center justify-between">
              <span className="text-fg-2">Leave focus mode</span>
              <Kbd>Esc</Kbd>
            </li>
          </ul>
        </DialogContent>
      </Dialog>
      <Dialog open={open === 'about'} onOpenChange={close}>
        <DialogContent
          title="About Tracer"
          description="A browser network simulator for learning how networks work."
        >
          <p className="text-sm text-fg-2">
            Tracer is an independent project and is not affiliated with or endorsed by Cisco
            Systems. Cisco and Packet Tracer are trademarks of Cisco Systems, Inc.
          </p>
          <p className="text-sm text-fg-2">
            Open source under the MIT licence.{' '}
            <a
              href="https://github.com/novierstudio/tracer"
              target="_blank"
              rel="noreferrer"
              className="text-accent-text underline-offset-2 hover:underline"
            >
              View the source on GitHub
            </a>
          </p>
        </DialogContent>
      </Dialog>
    </>
  );
}
