export type ShortcutId =
  | 'togglePalette'
  | 'toggleInspector'
  | 'toggleBottom'
  | 'focusMode'
  | 'toggleMode'
  | 'showShortcuts';

type Shortcut = { key: string; mod?: true; label: string };

// One table drives key handling, tooltips and the cheat sheet. F, ⌘Enter and ? come from the
// UI/UX doc; the doc names no per-panel keys, so [ ] and ` follow common editor conventions.
export const SHORTCUTS: Record<ShortcutId, Shortcut> = {
  togglePalette: { key: '[', label: 'Toggle device palette' },
  toggleInspector: { key: ']', label: 'Toggle inspector' },
  toggleBottom: { key: '`', label: 'Toggle bottom panel' },
  focusMode: { key: 'f', label: 'Focus mode' },
  toggleMode: { key: 'Enter', mod: true, label: 'Switch Realtime / Simulation' },
  showShortcuts: { key: '?', label: 'Keyboard shortcuts' },
};

type KeyInput = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey'>;

export function matchShortcut(event: KeyInput): ShortcutId | undefined {
  if (event.altKey) return undefined;
  const mod = event.metaKey || event.ctrlKey;
  const key = event.key.toLowerCase();
  return (Object.keys(SHORTCUTS) as ShortcutId[]).find((id) => {
    const shortcut = SHORTCUTS[id];
    return shortcut.key.toLowerCase() === key && Boolean(shortcut.mod) === mod;
  });
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent);

export function formatKeys(key: string, mod = false): string {
  const label = key === 'Enter' ? '↵' : key.toUpperCase();
  if (!mod) return label;
  return isMac ? `⌘${label}` : `Ctrl ${label}`;
}

export function formatShortcut(id: ShortcutId): string {
  const { key, mod } = SHORTCUTS[id];
  return formatKeys(key, mod);
}
