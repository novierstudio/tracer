export type ShortcutId =
  | 'commandPalette'
  | 'undo'
  | 'redo'
  | 'togglePalette'
  | 'toggleInspector'
  | 'toggleBottom'
  | 'focusMode'
  | 'toggleMode'
  | 'showShortcuts';

// `inTextFields` shortcuts also fire while typing in a text field. `shift` is only checked when set,
// so `?` matches whether or not the layout needs Shift for it.
type Shortcut = { key: string; mod?: true; shift?: boolean; inTextFields?: true; label: string };

// One table drives key handling, tooltips and the cheat sheet. ⌘K, F, ⌘Enter and ? come from the
// UI/UX doc; the doc names no per-panel keys, so [ ] and ` follow common editor conventions.
export const SHORTCUTS: Record<ShortcutId, Shortcut> = {
  commandPalette: { key: 'k', mod: true, inTextFields: true, label: 'Command palette' },
  undo: { key: 'z', mod: true, shift: false, label: 'Undo' },
  redo: { key: 'z', mod: true, shift: true, label: 'Redo' },
  togglePalette: { key: '[', label: 'Toggle device palette' },
  toggleInspector: { key: ']', label: 'Toggle inspector' },
  toggleBottom: { key: '`', label: 'Toggle bottom panel' },
  focusMode: { key: 'f', label: 'Focus mode' },
  toggleMode: { key: 'Enter', mod: true, label: 'Switch Realtime / Simulation' },
  showShortcuts: { key: '?', label: 'Keyboard shortcuts' },
};

type KeyInput = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey'> &
  Partial<Pick<KeyboardEvent, 'shiftKey'>>;

export function matchShortcut(event: KeyInput): ShortcutId | undefined {
  if (event.altKey) return undefined;
  const mod = event.metaKey || event.ctrlKey;
  const key = event.key.toLowerCase();
  return (Object.keys(SHORTCUTS) as ShortcutId[]).find((id) => {
    const shortcut = SHORTCUTS[id];
    if (shortcut.shift !== undefined && shortcut.shift !== Boolean(event.shiftKey)) return false;
    return shortcut.key.toLowerCase() === key && Boolean(shortcut.mod) === mod;
  });
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent);

export function formatKeys(key: string, mod = false, shift = false): string {
  const label = key === 'Enter' ? '↵' : key.toUpperCase();
  if (!mod) return label;
  if (isMac) return `${shift ? '⇧' : ''}⌘${label}`;
  return `Ctrl ${shift ? 'Shift ' : ''}${label}`;
}

export function formatShortcut(id: ShortcutId): string {
  const { key, mod, shift } = SHORTCUTS[id];
  return formatKeys(key, mod, shift);
}
