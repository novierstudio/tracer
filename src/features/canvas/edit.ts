import {
  createIdSource,
  Hostname,
  type AnnotationId,
  type DeviceId,
  type LinkId,
  type Move,
  type Point,
} from '@/model';
import { editorStore, type EditorStore } from '@/model/store';
import { alignMoves, distributeMoves, type AlignEdge, type Axis } from './arrange';
import { cableTool } from './cableTool';
import { canvasUi } from './canvasUi';
import { copyFragment, fragmentCentre, pasteElements, type Fragment } from './clipboard';
import { GRID, snap } from './geometry';

// Canvas edits that span the editor store and the canvas's own state. Each is one undo step.

export type CanvasSelection = { devices: DeviceId[]; links: LinkId[]; notes: AnnotationId[] };

export function currentSelection(): CanvasSelection {
  const { devices, links } = editorStore.getState().selection;
  return { devices, links, notes: canvasUi.getState().notes };
}

export function setSelection({ devices, links, notes }: CanvasSelection) {
  editorStore.getState().select({ devices, links });
  canvasUi.setState({ notes });
}

export const hasSelection = () => {
  const { devices, links, notes } = currentSelection();
  return devices.length + links.length + notes.length > 0;
};

export function selectAll() {
  const { topology } = editorStore.getState();
  setSelection({
    devices: Object.keys(topology.devices) as DeviceId[],
    links: Object.keys(topology.links) as LinkId[],
    notes: Object.keys(topology.annotations) as AnnotationId[],
  });
}

/** Runs edits as one undo step. */
function step(edit: (editor: ReturnType<EditorStore['getState']>) => void) {
  const editor = editorStore.getState();
  editor.beginGesture();
  try {
    edit(editor);
  } finally {
    editor.endGesture();
  }
}

export function deleteSelection() {
  const { devices, links, notes } = currentSelection();
  if (devices.length + links.length + notes.length === 0) return;
  step((editor) => {
    editor.removeLinks(links);
    editor.removeDevices(devices);
    editor.removeAnnotations(notes);
  });
}

let clipboard: Fragment | undefined;
// Each paste of the same copy lands one step further along, so pastes never stack exactly.
let pastes = 0;
const PASTE_STEP = GRID * 2;

export const canPaste = () => clipboard !== undefined;

function copyOf({ devices, notes }: CanvasSelection) {
  return copyFragment(editorStore.getState().topology, { devices, notes });
}

export function copySelection() {
  const fragment = copyOf(currentSelection());
  if (!fragment) return;
  clipboard = fragment;
  pastes = 0;
}

export function cutSelection() {
  copySelection();
  if (clipboard) deleteSelection();
}

const ids = createIdSource();

function insert(fragment: Fragment, offset: Point) {
  const editor = editorStore.getState();
  const elements = pasteElements(editor.topology, fragment, { ids, offset });
  const result = editor.addElements(elements);
  if (!result.ok) return;
  setSelection({
    devices: elements.devices.map((device) => device.id),
    links: elements.links.map((link) => link.id),
    notes: elements.annotations.map((note) => note.id),
  });
}

/** Pastes the last copy, centred on `at` when given, else offset from the original. */
export function paste(at?: Point) {
  if (!clipboard) return;
  if (at) {
    const from = fragmentCentre(clipboard);
    insert(clipboard, { x: snap(at.x - from.x), y: snap(at.y - from.y) });
    return;
  }
  pastes += 1;
  insert(clipboard, { x: PASTE_STEP * pastes, y: PASTE_STEP * pastes });
}

/** Copies and pastes in one go, leaving the clipboard alone. */
export function duplicateSelection() {
  const fragment = copyOf(currentSelection());
  if (fragment) insert(fragment, { x: PASTE_STEP, y: PASTE_STEP });
}

export const NUDGE = { near: GRID, far: GRID * 4 };

const ARROWS: Record<string, Point> = {
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
};

/** Moves the selected devices and notes one grid step per arrow press, four with Shift. */
export function nudge(event?: Pick<KeyboardEvent, 'key' | 'shiftKey'>) {
  const direction = event && ARROWS[event.key];
  if (!direction) return;
  const distance = event.shiftKey ? NUDGE.far : NUDGE.near;
  const by = (p: Point) => ({ x: p.x + direction.x * distance, y: p.y + direction.y * distance });
  const { topology } = editorStore.getState();
  const { devices, notes } = currentSelection();
  const deviceMoves = devices.flatMap((device) => {
    const at = topology.devices[device]?.position;
    return at ? [{ device, position: by(at) }] : [];
  });
  const noteMoves = notes.flatMap((annotation) => {
    const at = topology.annotations[annotation]?.position;
    return at ? [{ annotation, position: by(at) }] : [];
  });
  if (deviceMoves.length + noteMoves.length === 0) return;
  step((editor) => {
    editor.moveDevices(deviceMoves);
    editor.moveAnnotations(noteMoves);
  });
}

function selectedPlacements() {
  const { topology } = editorStore.getState();
  return currentSelection().devices.flatMap((device) => {
    const position = topology.devices[device]?.position;
    return position ? [{ device, position }] : [];
  });
}

export const canAlign = () => selectedPlacements().length >= 2;
export const canDistribute = () => selectedPlacements().length >= 3;

export function align(edge: AlignEdge) {
  const moves = alignMoves(selectedPlacements(), edge);
  if (moves.length > 0) editorStore.getState().moveDevices(moves);
}

export function distribute(axis: Axis) {
  const moves = distributeMoves(selectedPlacements(), axis);
  if (moves.length > 0) editorStore.getState().moveDevices(moves);
}

const easeOut = (t: number) => 1 - (1 - t) ** 3;

/**
 * Slides devices to their new positions as one undo step. It stops where it is if anything else
 * changes the lab mid-flight, such as an undo.
 */
export function animateMoves(editor: EditorStore, moves: readonly Move[], duration: number) {
  if (moves.length === 0) return Promise.resolve();
  if (duration <= 0) {
    editor.getState().moveDevices(moves);
    return Promise.resolve();
  }
  const { topology } = editor.getState();
  const starts = moves.map(({ device }) => topology.devices[device]?.position);
  editor.getState().beginGesture();
  let last = editor.getState().topology;
  const began = performance.now();
  return new Promise<void>((resolve) => {
    const frame = (now: number) => {
      if (editor.getState().topology !== last) {
        editor.getState().endGesture();
        return resolve();
      }
      const t = Math.min(1, (now - began) / duration);
      const k = easeOut(t);
      editor.getState().moveDevices(
        moves.map(({ device, position }, i) => {
          const from = starts[i] ?? position;
          return {
            device,
            position:
              t === 1
                ? position
                : { x: from.x + (position.x - from.x) * k, y: from.y + (position.y - from.y) * k },
          };
        }),
      );
      last = editor.getState().topology;
      if (t < 1) return void requestAnimationFrame(frame);
      editor.getState().endGesture();
      resolve();
    };
    requestAnimationFrame(frame);
  });
}

/** Lays the whole lab out top-down with ELK, as one undo step. */
export async function autoLayout({
  editor = editorStore,
  duration = 0,
}: { editor?: EditorStore; duration?: number } = {}) {
  const before = editor.getState().topology;
  const { layoutTopology } = await import('./layout');
  const moves = await layoutTopology(before);
  // Someone edited the lab while ELK ran; their positions win.
  if (editor.getState().topology !== before) return;
  await animateMoves(editor, moves, duration);
}

/** Starts a note at `position`. It joins the lab when it has text. */
export function startNote(position: Point) {
  cableTool.getState().exit();
  canvasUi.setState({
    edit: { kind: 'new-note', position: { x: snap(position.x), y: snap(position.y) } },
  });
}

export function editNote(note: AnnotationId) {
  canvasUi.setState({ edit: { kind: 'note', note } });
}

export function startRename(device: DeviceId) {
  canvasUi.setState({ edit: { kind: 'rename', device } });
}

export const stopEditing = () => canvasUi.setState({ edit: null });

/**
 * Saves what was typed. An empty note is dropped, and clearing a note deletes it. A hostname the
 * device cannot take keeps the old name and returns the reason.
 */
export function finishEditing(text: string): string | undefined {
  const { edit } = canvasUi.getState();
  const editor = editorStore.getState();
  const trimmed = text.trim();
  stopEditing();
  if (!edit) return undefined;
  switch (edit.kind) {
    case 'new-note': {
      if (!trimmed) return undefined;
      const result = editor.addNote({ position: edit.position, text: text.trimEnd() });
      if (result.ok) setSelection({ devices: [], links: [], notes: [result.value] });
      return undefined;
    }
    case 'note':
      if (!trimmed) editor.removeAnnotations([edit.note]);
      else editor.editNote({ annotation: edit.note, text: text.trimEnd() });
      return undefined;
    case 'rename': {
      const hostname = Hostname.safeParse(trimmed);
      if (!hostname.success) return hostname.error.issues[0]?.message;
      const result = editor.renameDevice({ device: edit.device, hostname: hostname.data });
      return result.ok ? undefined : 'That name cannot be used.';
    }
  }
}
