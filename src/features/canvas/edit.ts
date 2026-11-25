import {
  createIdSource,
  Hostname,
  type AnnotationId,
  type AnnotationSpec,
  type DeviceId,
  type LinkId,
  type Move,
  type Point,
  type Size,
} from '@/model';
import { editorStore, type EditorStore, type Selection } from '@/model/store';
import {
  annotationText,
  draftSpec,
  drawnSpec,
  placedSpec,
  resized,
  withText,
  type DrawTool,
} from './annotations';
import { alignMoves, distributeMoves, type AlignEdge, type Axis } from './arrange';
import { cableTool } from './cableTool';
import { canvasUi } from './canvasUi';
import { copyFragment, fragmentCentre, pasteElements, type Fragment } from './clipboard';
import { GRID, snap } from './geometry';

// Canvas edits on the editor store and the canvas's own state. Each is one undo step.

const selection = () => editorStore.getState().selection;
const select = (next: Partial<Selection>) => editorStore.getState().select(next);

export const hasSelection = () => {
  const { devices, links, annotations } = selection();
  return devices.length + links.length + annotations.length > 0;
};

export function selectAll() {
  const { topology } = editorStore.getState();
  select({
    devices: Object.keys(topology.devices) as DeviceId[],
    links: Object.keys(topology.links) as LinkId[],
    annotations: Object.keys(topology.annotations) as AnnotationId[],
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
  const { devices, links, annotations } = selection();
  if (devices.length + links.length + annotations.length === 0) return;
  step((editor) => {
    editor.removeLinks(links);
    editor.removeDevices(devices);
    editor.removeAnnotations(annotations);
  });
}

let clipboard: Fragment | undefined;
// Each paste of the same copy lands one step further along, so pastes never stack exactly.
let pastes = 0;
const PASTE_STEP = GRID * 2;

export const canPaste = () => clipboard !== undefined;

function copyOf({ devices, annotations }: Selection) {
  return copyFragment(editorStore.getState().topology, { devices, annotations });
}

export function copySelection() {
  const fragment = copyOf(selection());
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
  select({
    devices: elements.devices.map((device) => device.id),
    links: elements.links.map((link) => link.id),
    annotations: elements.annotations.map((annotation) => annotation.id),
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
  const fragment = copyOf(selection());
  if (fragment) insert(fragment, { x: PASTE_STEP, y: PASTE_STEP });
}

const NUDGE = { near: GRID, far: GRID * 4 };

export const ARROWS: Record<string, Point> = {
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
};

/** Moves the selected devices and annotations one grid step per arrow press, four with Shift. */
export function nudge(event?: Pick<KeyboardEvent, 'key' | 'shiftKey'>) {
  const direction = event && ARROWS[event.key];
  if (!direction) return;
  const distance = event.shiftKey ? NUDGE.far : NUDGE.near;
  const by = (p: Point) => ({ x: p.x + direction.x * distance, y: p.y + direction.y * distance });
  const { topology } = editorStore.getState();
  const { devices, annotations } = selection();
  const deviceMoves = devices.flatMap((device) => {
    const at = topology.devices[device]?.position;
    return at ? [{ device, position: by(at) }] : [];
  });
  const annotationMoves = annotations.flatMap((annotation) => {
    const at = topology.annotations[annotation]?.position;
    return at ? [{ annotation, position: by(at) }] : [];
  });
  if (deviceMoves.length + annotationMoves.length === 0) return;
  step((editor) => {
    editor.moveDevices(deviceMoves);
    editor.moveAnnotations(annotationMoves);
  });
}

function selectedPlacements() {
  const { topology } = editorStore.getState();
  return selection().devices.flatMap((device) => {
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

/** Starts a note or text at `position`. It joins the lab once it has text. */
export function startTyping(tool: 'note' | 'text', position: Point) {
  stopTools();
  canvasUi.setState({ edit: { kind: 'new', annotation: draftSpec(tool, position) } });
}

/** Edits an annotation's text in place. Shapes have none. */
export function editText(id: AnnotationId) {
  const annotation = editorStore.getState().topology.annotations[id];
  if (!annotation || annotationText(annotation) === undefined) return;
  canvasUi.setState({ edit: { kind: 'annotation', annotation: id } });
}

export function startRename(device: DeviceId) {
  canvasUi.setState({ edit: { kind: 'rename', device } });
}

export const stopEditing = () => canvasUi.setState({ edit: null });

/** Arms a tool that drags out a box, or disarms it when it is already armed. */
export function toggleDrawTool(tool: DrawTool) {
  const armed = canvasUi.getState().drawing === tool;
  stopTools();
  if (!armed) canvasUi.setState({ drawing: tool });
}

/** Turns the cable tool on or off, leaving any draw tool. */
export function toggleCableTool() {
  if (canvasUi.getState().drawing) canvasUi.setState({ drawing: null });
  cableTool.getState().toggle();
}

/** Leaves the cable and draw tools. */
export function stopTools() {
  cableTool.getState().exit();
  if (canvasUi.getState().drawing) canvasUi.setState({ drawing: null });
}

function addAnnotation(spec: AnnotationSpec) {
  const result = editorStore.getState().addAnnotation(spec);
  if (!result.ok) return undefined;
  select({ annotations: [result.value] });
  // A new area box is named straight away, so its label field opens with "Area" selected.
  if (spec.kind === 'area') editText(result.value);
  return result.value;
}

/** Adds what a draw tool dragged out, and disarms it. */
export function drawAnnotation(tool: DrawTool, box: { position: Point; size: Size }) {
  canvasUi.setState({ drawing: null });
  return addAnnotation(drawnSpec(tool, box));
}

/** Adds a draw tool's default box centred on `at`. */
export function placeAnnotation(tool: DrawTool, at: Point) {
  stopTools();
  return addAnnotation(placedSpec(tool, at));
}

/** Applies what a resize handle reports. The handle's gesture makes the drag one undo step. */
export function resizeAnnotation(
  id: AnnotationId,
  box: { position?: Point; width?: number; height?: number },
) {
  const editor = editorStore.getState();
  const current = editor.topology.annotations[id];
  if (!current) return;
  editor.updateAnnotation(resized(current, { ...box, position: box.position ?? current.position }));
}

/**
 * Saves what was typed. An empty new note or text is dropped, and clearing one deletes it; an area
 * may have no label. A hostname the device cannot take keeps the old name and returns the reason.
 */
export function finishEditing(text: string): string | undefined {
  const { edit } = canvasUi.getState();
  const editor = editorStore.getState();
  const trimmed = text.trim();
  stopEditing();
  if (!edit) return undefined;
  switch (edit.kind) {
    case 'new': {
      if (!trimmed) return undefined;
      const result = editor.addAnnotation(withText(edit.annotation, text.trimEnd()));
      if (result.ok) select({ annotations: [result.value] });
      return undefined;
    }
    case 'annotation': {
      const current = editor.topology.annotations[edit.annotation];
      if (!current) return undefined;
      const area = current.kind === 'area';
      if (!trimmed && !area) editor.removeAnnotations([current.id]);
      else editor.updateAnnotation(withText(current, area ? trimmed : text.trimEnd()));
      return undefined;
    }
    case 'rename': {
      const hostname = Hostname.safeParse(trimmed);
      if (!hostname.success) return hostname.error.issues[0]?.message;
      const result = editor.renameDevice({ device: edit.device, hostname: hostname.data });
      return result.ok ? undefined : 'That name cannot be used.';
    }
  }
}
