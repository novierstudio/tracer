import {
  ChevronDownIcon,
  FilePlusIcon,
  FolderOpenIcon,
  InfoIcon,
  KeyboardIcon,
  PanelBottomIcon,
  PanelLeftIcon,
  PanelRightIcon,
  PlayIcon,
  RadioIcon,
  Redo2Icon,
  SaveIcon,
  SearchIcon,
  Undo2Icon,
} from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';
import { Kbd } from '@/ui/kbd';
import { Segmented } from '@/ui/segmented';
import { Tooltip } from '@/ui/tooltip';
import iconUrl from '../../../assets/icon.svg';
import { ThemeMenu } from '../ThemeMenu';
import type { HelpDialog } from './HelpDialogs';
import { formatKeys, formatShortcut, SHORTCUTS, type ShortcutId } from './shortcuts';

export type Mode = 'realtime' | 'simulation';

const MODE_OPTIONS = [
  { value: 'realtime', label: 'Realtime', icon: <RadioIcon /> },
  {
    value: 'simulation',
    label: 'Simulation',
    icon: <PlayIcon />,
    activeClassName: 'data-[state=on]:bg-warn/15 data-[state=on]:text-warn',
  },
] as const;

const PANEL_ICONS = {
  togglePalette: PanelLeftIcon,
  toggleBottom: PanelBottomIcon,
  toggleInspector: PanelRightIcon,
} as const satisfies Partial<Record<ShortcutId, unknown>>;

export type PanelToggle = { id: keyof typeof PANEL_ICONS; open: boolean; onToggle: () => void };

type TopBarProps = {
  mode: Mode;
  onModeChange: (mode: Mode) => void;
  panels: { palette: PanelToggle; bottom: PanelToggle; inspector: PanelToggle };
  onOpenHelp: (dialog: HelpDialog) => void;
};

function AppMenu({ onOpenHelp }: Pick<TopBarProps, 'onOpenHelp'>) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="gap-2 px-1.5 text-fg-1"
          aria-label="Tracer menu"
        >
          <img src={iconUrl} alt="" className="size-5 rounded-[5px]" />
          <span className="text-sm font-semibold max-sm:sr-only">Tracer</span>
          <ChevronDownIcon className="size-3.5 text-fg-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-56">
        <DropdownMenuLabel>File · coming soon</DropdownMenuLabel>
        <DropdownMenuItem disabled>
          <FilePlusIcon />
          New lab
        </DropdownMenuItem>
        <DropdownMenuItem disabled>
          <FolderOpenIcon />
          Open…
          <DropdownMenuShortcut>{formatKeys('o', true)}</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem disabled>
          <SaveIcon />
          Save
          <DropdownMenuShortcut>{formatKeys('s', true)}</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => onOpenHelp('shortcuts')}>
          <KeyboardIcon />
          Keyboard shortcuts
          <DropdownMenuShortcut>{formatShortcut('showShortcuts')}</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onOpenHelp('about')}>
          <InfoIcon />
          About Tracer
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function FileName() {
  const [name, setName] = useState('Untitled lab');
  return (
    <input
      aria-label="Lab name"
      value={name}
      onChange={(e) => setName(e.target.value)}
      onBlur={() => setName((n) => n.trim() || 'Untitled lab')}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur();
      }}
      className="h-7 w-44 min-w-0 truncate rounded-md border border-transparent bg-transparent px-1.5 text-sm text-fg-1 outline-none hover:border-line focus-visible:border-accent focus-visible:bg-surface-1 focus-visible:outline-none max-sm:flex-1"
    />
  );
}

function PanelButton({ toggle, className }: { toggle: PanelToggle; className?: string }) {
  const Icon = PANEL_ICONS[toggle.id];
  const { label } = SHORTCUTS[toggle.id];
  return (
    <Tooltip label={label} shortcut={formatShortcut(toggle.id)}>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={label}
        aria-pressed={toggle.open}
        onClick={toggle.onToggle}
        className={className}
      >
        <Icon />
      </Button>
    </Tooltip>
  );
}

export function TopBar({ mode, onModeChange, panels, onOpenHelp }: TopBarProps) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-surface-1 px-2">
      <div className="flex min-w-0 flex-1 items-center gap-1">
        <AppMenu onOpenHelp={onOpenHelp} />
        <span className="text-fg-3 select-none max-sm:hidden" aria-hidden>
          /
        </span>
        <FileName />
        <div className="flex items-center max-md:hidden">
          <Button variant="ghost" size="icon-sm" aria-label="Undo" disabled>
            <Undo2Icon />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="Redo" disabled>
            <Redo2Icon />
          </Button>
        </div>
      </div>

      <Tooltip label="Switch mode" shortcut={formatShortcut('toggleMode')}>
        <div>
          <Segmented
            label="Mode"
            value={mode}
            onValueChange={onModeChange}
            options={MODE_OPTIONS}
            hideLabelsBelow="md"
          />
        </div>
      </Tooltip>

      <div className="flex flex-1 items-center justify-end gap-1">
        <Button
          variant="secondary"
          size="sm"
          disabled
          className="mr-1 w-48 justify-start pr-1 text-fg-3 max-lg:hidden"
          aria-label="Command palette (coming soon)"
        >
          <SearchIcon />
          Search…
          <Kbd className="ml-auto">{formatKeys('k', true)}</Kbd>
        </Button>
        <PanelButton toggle={panels.palette} className="max-sm:hidden" />
        <PanelButton toggle={panels.bottom} />
        <PanelButton toggle={panels.inspector} />
        <ThemeMenu />
      </div>
    </header>
  );
}
