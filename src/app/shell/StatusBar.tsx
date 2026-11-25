import { KeyboardIcon } from 'lucide-react';
import { SaveStatus } from '@/features/files/SaveStatus';
import { EngineStatus } from '@/features/simulation/EngineStatus';
import { useEditor } from '@/model/react';
import { cn } from '@/ui/cn';
import type { HelpDialog } from './HelpDialogs';
import type { Mode } from './TopBar';

type StatusBarProps = { mode: Mode; onOpenHelp: (dialog: HelpDialog) => void; inert: boolean };

const linkClass =
  'flex h-full cursor-default items-center gap-1 px-1.5 hover:bg-surface-2 hover:text-fg-1';

const count = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

function LabCounts() {
  const devices = useEditor((state) => Object.keys(state.topology.devices).length);
  const links = useEditor((state) => Object.keys(state.topology.links).length);
  return (
    <span className="max-sm:hidden">
      {devices === 0 ? 'Empty lab' : `${count(devices, 'device')} · ${count(links, 'link')}`}
    </span>
  );
}

export function StatusBar({ mode, onOpenHelp, inert }: StatusBarProps) {
  return (
    <footer
      inert={inert}
      className="flex h-7 shrink-0 items-center gap-3 border-t border-line bg-surface-1 px-2 text-2xs text-fg-2"
    >
      <span className="flex items-center gap-1.5 px-1.5">
        <span
          aria-hidden
          className={cn('size-1.5 rounded-full', mode === 'realtime' ? 'bg-ok' : 'bg-warn')}
        />
        {mode === 'realtime' ? 'Realtime' : 'Simulation · paused'}
      </span>
      <LabCounts />
      <EngineStatus />
      <div className="ml-auto flex h-full items-center">
        <SaveStatus />
        <button type="button" className={linkClass} onClick={() => onOpenHelp('shortcuts')}>
          <KeyboardIcon className="size-3.5" />
          <span className="max-sm:sr-only">Shortcuts</span>
        </button>
        <button type="button" className={linkClass} onClick={() => onOpenHelp('about')}>
          Not affiliated with Cisco
        </button>
      </div>
    </footer>
  );
}
