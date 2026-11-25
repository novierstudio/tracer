export type ShortcutId =
  | 'commandPalette'
  | 'undo'
  | 'redo'
  | 'save'
  | 'saveAs'
  | 'open'
  | 'togglePalette'
  | 'toggleInspector'
  | 'toggleBottom'
  | 'focusMode'
  | 'toggleMode'
  | 'showShortcuts'
  | 'fitView'
  | 'zoomIn'
  | 'zoomOut'
  | 'selectTool'
  | 'cableTool'
  | 'deleteSelection'
  | 'selectAll'
  | 'copy'
  | 'cut'
  | 'paste'
  | 'duplicate'
  | 'nudge'
  | 'rename'
  | 'addRouter'
  | 'addSwitch'
  | 'addPc'
  | 'addNote';

// `inTextFields` shortcuts also fire while typing in a text field. `shift` is only checked when set,
// so `?` matches whether or not the layout needs Shift for it. `also` lists other keys that do the
// same and are left out of labels, unless `keyLabel` names them all. `canvasOnly` shortcuts fire only
// while the canvas has focus.
type Shortcut = {
  key: string;
  also?: readonly string[];
  keyLabel?: string;
  mod?: true;
  shift?: boolean;
  inTextFields?: true;
  canvasOnly?: true;
  label: string;
};

// One table drives key handling, tooltips and the cheat sheet. ⌘K, F, ⌘Enter, ?, V, C, N, R/S/P,
// ⌘C/⌘V/⌘D and Delete come from the UI/UX doc; the doc names no per-panel keys, so [ ] and ` follow
// common editor conventions, as do ⌘X, F2 and the arrow keys. Fit is 1 or Shift+1 (`!` on US
// keyboards), and 0 as the doc has it. Clipboard keys are canvas-only, so text elsewhere still copies.
export const SHORTCUTS: Record<ShortcutId, Shortcut> = {
  commandPalette: { key: 'k', mod: true, inTextFields: true, label: 'Command palette' },
  undo: { key: 'z', mod: true, shift: false, label: 'Undo' },
  redo: { key: 'z', mod: true, shift: true, label: 'Redo' },
  save: { key: 's', mod: true, shift: false, inTextFields: true, label: 'Save lab' },
  saveAs: { key: 's', mod: true, shift: true, inTextFields: true, label: 'Save lab as' },
  open: { key: 'o', mod: true, inTextFields: true, label: 'Open lab' },
  togglePalette: { key: '[', label: 'Toggle device palette' },
  toggleInspector: { key: ']', label: 'Toggle inspector' },
  toggleBottom: { key: '`', label: 'Toggle bottom panel' },
  focusMode: { key: 'f', label: 'Focus mode' },
  toggleMode: { key: 'Enter', mod: true, label: 'Switch Realtime / Simulation' },
  showShortcuts: { key: '?', label: 'Keyboard shortcuts' },
  fitView: { key: '1', also: ['!', '0'], label: 'Zoom to fit' },
  zoomIn: { key: '=', also: ['+'], label: 'Zoom in' },
  zoomOut: { key: '-', also: ['_'], label: 'Zoom out' },
  selectTool: { key: 'v', label: 'Select tool' },
  cableTool: { key: 'c', label: 'Cable tool' },
  deleteSelection: { key: 'Backspace', also: ['Delete'], label: 'Delete selection' },
  selectAll: { key: 'a', mod: true, canvasOnly: true, label: 'Select all' },
  copy: { key: 'c', mod: true, canvasOnly: true, label: 'Copy' },
  cut: { key: 'x', mod: true, canvasOnly: true, label: 'Cut' },
  paste: { key: 'v', mod: true, canvasOnly: true, label: 'Paste' },
  duplicate: { key: 'd', mod: true, canvasOnly: true, label: 'Duplicate' },
  nudge: {
    key: 'ArrowUp',
    also: ['ArrowDown', 'ArrowLeft', 'ArrowRight'],
    keyLabel: '↑↓←→',
    canvasOnly: true,
    label: 'Nudge selection (hold Shift to move further)',
  },
  rename: { key: 'F2', canvasOnly: true, label: 'Rename device' },
  addRouter: { key: 'r', label: 'Add router at pointer' },
  addSwitch: { key: 's', label: 'Add switch at pointer' },
  addPc: { key: 'p', label: 'Add PC at pointer' },
  addNote: { key: 'n', label: 'Add note at pointer' },
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
    const keys = [shortcut.key, ...(shortcut.also ?? [])];
    return keys.some((k) => k.toLowerCase() === key) && Boolean(shortcut.mod) === mod;
  });
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent);

const KEY_LABELS: Record<string, string> = { Enter: '↵', Backspace: '⌫' };

export function formatKeys(key: string, mod = false, shift = false): string {
  const label = KEY_LABELS[key] ?? key.toUpperCase();
  if (!mod) return label;
  if (isMac) return `${shift ? '⇧' : ''}⌘${label}`;
  return `Ctrl ${shift ? 'Shift ' : ''}${label}`;
}

export function formatShortcut(id: ShortcutId): string {
  const { key, mod, shift, keyLabel } = SHORTCUTS[id];
  return keyLabel ?? formatKeys(key, mod, shift);
}
