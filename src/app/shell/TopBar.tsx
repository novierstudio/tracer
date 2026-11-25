import {
  ChevronDownIcon,
  InfoIcon,
  KeyboardIcon,
  LayoutGridIcon,
  PanelBottomIcon,
  PanelLeftIcon,
  PanelRightIcon,
  PlayIcon,
  RadioIcon,
  Redo2Icon,
  SearchIcon,
  SparklesIcon,
  Undo2Icon,
} from 'lucide-react';
import { useState } from 'react';
import { FileMenuItems } from '@/features/files/FileMenuItems';
import { fileSession } from '@/features/files/session';
import { ShareButton } from '@/features/files/ShareDialogs';
import { onboarding } from '@/features/onboarding/store';
import { LabSettingsMenuItem } from '@/features/settings/LabSettings';
import { ShowTrafficToggle } from '@/features/simulation/ShowTrafficToggle';
import { Button } from '@/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';
import { Kbd } from '@/ui/kbd';
import { Segmented } from '@/ui/segmented';
import { editorStore } from '@/model/store';
import { useEditor, useHistory } from '@/model/react';
import { Tooltip } from '@/ui/tooltip';
import iconUrl from '../../../assets/icon.svg';
import { ThemeMenu } from '../ThemeMenu';
import type { HelpDialog } from './HelpDialogs';
import { formatShortcut, matchShortcut, SHORTCUTS, type ShortcutId } from './shortcuts';

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
  onOpenCommands: () => void;
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
        <FileMenuItems />
        <DropdownMenuSeparator />
        <LabSettingsMenuItem />
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onboarding.openGallery}>
          <LayoutGridIcon />
          Sample labs…
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onboarding.showWelcome}>
          <SparklesIcon />
          Welcome
        </DropdownMenuItem>
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

// Shows the lab name and keeps edits local until blur or Enter, so typing is one undo step.
function FileName() {
  const name = useEditor((state) => state.topology.meta.name);
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      aria-label="Lab name"
      value={draft ?? name}
      onFocus={() => setDraft(name)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== null) fileSession.rename(draft);
        setDraft(null);
      }}
      onKeyDown={(e) => {
        // Commit before a shortcut such as Save acts on the lab.
        const shortcut = matchShortcut(e.nativeEvent);
        const commit = shortcut && SHORTCUTS[shortcut].inTextFields;
        if (e.key === 'Enter' || e.key === 'Escape' || commit) e.currentTarget.blur();
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

export function HistoryButtons() {
  const canUndo = useHistory((history) => history.pastStates.length > 0);
  const canRedo = useHistory((history) => history.futureStates.length > 0);
  const { undo, redo } = editorStore.getState();
  return (
    <div className="flex items-center max-md:hidden">
      <Tooltip label="Undo" shortcut={formatShortcut('undo')}>
        <Button variant="ghost" size="icon-sm" aria-label="Undo" disabled={!canUndo} onClick={undo}>
          <Undo2Icon />
        </Button>
      </Tooltip>
      <Tooltip label="Redo" shortcut={formatShortcut('redo')}>
        <Button variant="ghost" size="icon-sm" aria-label="Redo" disabled={!canRedo} onClick={redo}>
          <Redo2Icon />
        </Button>
      </Tooltip>
    </div>
  );
}

export function TopBar({ mode, onModeChange, panels, onOpenHelp, onOpenCommands }: TopBarProps) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-surface-1 px-2">
      <div className="flex min-w-0 flex-1 items-center gap-1">
        <AppMenu onOpenHelp={onOpenHelp} />
        <span className="text-fg-3 select-none max-sm:hidden" aria-hidden>
          /
        </span>
        <FileName />
        <HistoryButtons />
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
      <ShowTrafficToggle />

      <div className="flex flex-1 items-center justify-end gap-1">
        <Button
          variant="secondary"
          size="sm"
          className="mr-1 w-48 justify-start pr-1 text-fg-3 max-lg:hidden"
          aria-label="Command palette"
          aria-haspopup="dialog"
          onClick={onOpenCommands}
        >
          <SearchIcon />
          Search…
          <Kbd className="ml-auto">{formatShortcut('commandPalette')}</Kbd>
        </Button>
        <Tooltip label="Command palette" shortcut={formatShortcut('commandPalette')}>
          <Button
            variant="ghost"
            size="icon-sm"
            className="lg:hidden"
            aria-label="Command palette"
            aria-haspopup="dialog"
            onClick={onOpenCommands}
          >
            <SearchIcon />
          </Button>
        </Tooltip>
        <ShareButton />
        <PanelButton toggle={panels.palette} className="max-sm:hidden" />
        <PanelButton toggle={panels.bottom} />
        <PanelButton toggle={panels.inspector} />
        <ThemeMenu />
      </div>
    </header>
  );
}
