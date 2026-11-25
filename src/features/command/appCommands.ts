import {
  InfoIcon,
  KeyboardIcon,
  MaximizeIcon,
  MonitorIcon,
  MoonIcon,
  PaletteIcon,
  PanelBottomIcon,
  PanelLeftIcon,
  PanelRightIcon,
  PlayIcon,
  RadioIcon,
  SunIcon,
} from 'lucide-react';
import type { HelpDialog } from '@/app/shell/HelpDialogs';
import type { ShortcutId } from '@/app/shell/shortcuts';
import type { Mode } from '@/app/shell/TopBar';
import { setThemePref } from '@/app/theme';
import type { Command } from './registry';

export type ShellActions = {
  mode: Mode;
  runShortcut: (id: ShortcutId) => void;
  openHelp: (dialog: HelpDialog) => void;
};

// Commands for what the shell can do today. Features register their own commands as they land.
export function appCommands({ mode, runShortcut, openHelp }: ShellActions): Command[] {
  const viaShortcut = (shortcut: ShortcutId) => ({ shortcut, run: () => runShortcut(shortcut) });
  return [
    {
      id: 'view.togglePalette',
      title: 'Toggle device palette',
      group: 'View',
      keywords: ['left', 'panel', 'sidebar', 'devices'],
      icon: PanelLeftIcon,
      ...viaShortcut('togglePalette'),
    },
    {
      id: 'view.toggleInspector',
      title: 'Toggle inspector',
      group: 'View',
      keywords: ['right', 'panel', 'sidebar', 'properties'],
      icon: PanelRightIcon,
      ...viaShortcut('toggleInspector'),
    },
    {
      id: 'view.toggleBottom',
      title: 'Toggle bottom panel',
      group: 'View',
      keywords: ['panel', 'timeline', 'events'],
      icon: PanelBottomIcon,
      ...viaShortcut('toggleBottom'),
    },
    {
      id: 'view.focusMode',
      title: 'Toggle focus mode',
      group: 'View',
      keywords: ['zen', 'fullscreen', 'hide panels', 'canvas'],
      icon: MaximizeIcon,
      ...viaShortcut('focusMode'),
    },
    {
      id: 'mode.simulation',
      title: 'Switch to Simulation mode',
      group: 'Mode',
      keywords: ['step', 'packets', 'toggle'],
      icon: PlayIcon,
      enabled: () => mode === 'realtime',
      ...viaShortcut('toggleMode'),
    },
    {
      id: 'mode.realtime',
      title: 'Switch to Realtime mode',
      group: 'Mode',
      keywords: ['live', 'toggle'],
      icon: RadioIcon,
      enabled: () => mode === 'simulation',
      ...viaShortcut('toggleMode'),
    },
    {
      id: 'theme.light',
      title: 'Light theme',
      group: 'Theme',
      keywords: ['appearance', 'colour', 'color'],
      icon: SunIcon,
      run: () => setThemePref('light'),
    },
    {
      id: 'theme.dark',
      title: 'Dark theme',
      group: 'Theme',
      keywords: ['appearance', 'colour', 'color'],
      icon: MoonIcon,
      run: () => setThemePref('dark'),
    },
    {
      id: 'theme.system',
      title: 'Match system theme',
      group: 'Theme',
      keywords: ['appearance', 'colour', 'color', 'auto', 'os'],
      icon: MonitorIcon,
      run: () => setThemePref('system'),
    },
    {
      id: 'help.shortcuts',
      title: 'Keyboard shortcuts',
      group: 'Help',
      keywords: ['cheat sheet', 'keys', 'hotkeys'],
      icon: KeyboardIcon,
      ...viaShortcut('showShortcuts'),
    },
    {
      id: 'help.about',
      title: 'About Tracer',
      group: 'Help',
      keywords: ['version', 'licence', 'license', 'cisco', 'github'],
      icon: InfoIcon,
      run: () => openHelp('about'),
    },
    {
      id: 'dev.gallery',
      title: 'Open design system gallery',
      group: 'Developer',
      keywords: ['dev', 'ui', 'components', 'tokens'],
      icon: PaletteIcon,
      run: () => {
        window.location.hash = '#/dev/ui';
      },
    },
  ];
}
