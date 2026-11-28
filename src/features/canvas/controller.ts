import type { ReactFlowInstance } from '@xyflow/react';
import {
  AlignCenterHorizontalIcon,
  AlignCenterVerticalIcon,
  AlignEndHorizontalIcon,
  AlignEndVerticalIcon,
  AlignHorizontalDistributeCenterIcon,
  AlignStartHorizontalIcon,
  AlignStartVerticalIcon,
  AlignVerticalDistributeCenterIcon,
  CableIcon,
  ClipboardPasteIcon,
  CopyIcon,
  CopyPlusIcon,
  EthernetPortIcon,
  FullscreenIcon,
  MonitorIcon,
  PencilIcon,
  RouterIcon,
  ScanIcon,
  ScissorsIcon,
  SquareDashedMousePointerIcon,
  TagIcon,
  Trash2Icon,
  WorkflowIcon,
  ZoomInIcon,
  ZoomOutIcon,
  type LucideIcon,
} from 'lucide-react';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import type { ShortcutId } from '@/app/shell/shortcuts';
import { readJson, safeStorage } from '@/app/storage';
import type { DeviceModelId } from '@/devices/catalog';
import { deviceSpec } from '@/devices/create';
import type { DeviceId, Point } from '@/model';
import { editorStore } from '@/model/store';
import type { Command } from '@/features/command/registry';
import { ANNOTATION_TOOLS, isDrawTool, type AnnotationTool } from './annotations';
import { ALIGN_EDGES, type AlignEdge, type Axis } from './arrange';
import { cableTool } from './cableTool';
import { canvasUi } from './canvasUi';
import {
  align,
  autoLayout,
  canAlign,
  canDistribute,
  canPaste,
  copySelection,
  cutSelection,
  deleteSelection,
  distribute,
  duplicateSelection,
  hasSelection,
  nudge,
  paste,
  placeAnnotation,
  selectAll,
  startRename,
  startTyping,
  stopTools,
  toggleCableTool,
  toggleDrawTool,
} from './edit';
import type { CanvasEdge, CanvasNode } from './flow';
import { GRID, snapCentre } from './geometry';

type CanvasHandle = {
  flow: ReactFlowInstance<CanvasNode, CanvasEdge>;
  element: HTMLElement;
};

// The mounted canvas, for actions that start outside it: shortcuts, commands and the palette.
let mounted: CanvasHandle | null = null;

export function attachCanvas(handle: CanvasHandle): () => void {
  mounted = handle;
  return () => {
    if (mounted === handle) mounted = null;
  };
}

export function isCanvasTarget(target: EventTarget | null): boolean {
  return target instanceof Node && !!mounted?.element.contains(target);
}

const motion = () => (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : 200);

// Keeps fitted devices, and the labels under them, clear of the tool bar above and of the
// minimap, zoom controls and tool hint along the bottom.
export const FIT_VIEW = {
  padding: { top: '72px', right: '56px', bottom: '176px', left: '56px' },
  maxZoom: 1.25,
} as const;

export function fitView() {
  void mounted?.flow.fitView({ ...FIT_VIEW, duration: motion() });
}

export function zoomBy(direction: 'in' | 'out') {
  const flow = mounted?.flow;
  if (!flow) return;
  void (direction === 'in' ? flow.zoomIn : flow.zoomOut)({ duration: motion() });
}

export function zoomToActualSize() {
  void mounted?.flow.zoomTo(1, { duration: motion() });
}

// The pointer's last place over the canvas, in screen pixels so it stays right as the view pans.
let pointer: { x: number; y: number } | null = null;

export function trackPointer(at: { clientX: number; clientY: number } | null) {
  pointer = at && { x: at.clientX, y: at.clientY };
}

/** The pointer's last place over the canvas, in screen pixels. */
export const lastPointer = () => pointer;

function toFlowPoint(at: { x: number; y: number }): Point | undefined {
  return mounted?.flow.screenToFlowPosition(at);
}

export function viewCentre(): Point | undefined {
  if (!mounted) return undefined;
  const rect = mounted.element.getBoundingClientRect();
  return toFlowPoint({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
}

/** Where keyboard adds land: under the pointer when it is over the canvas, else mid-view. */
const pointerOrCentre = (): Point | undefined => (pointer && toFlowPoint(pointer)) ?? viewCentre();

/** The nearest grid point at or after `point`, stepping diagonally past devices already there. */
function freeSpot(point: Point, taken: readonly Point[]): Point {
  let spot = { x: snapCentre(point.x), y: snapCentre(point.y) };
  const occupied = (p: Point) =>
    taken.some((t) => Math.abs(t.x - p.x) < GRID * 2 && Math.abs(t.y - p.y) < GRID * 2);
  for (let i = 0; i < 50 && occupied(spot); i++)
    spot = { x: spot.x + GRID * 3, y: spot.y + GRID * 3 };
  return spot;
}

/** Adds a device at a flow point, or the middle of the view, named like Packet Tracer does. */
export function placeDevice(model: DeviceModelId, at?: Point) {
  const point = at ?? viewCentre();
  if (!point) return;
  const editor = editorStore.getState();
  const devices = Object.values(editor.topology.devices);
  const spec = deviceSpec(model, {
    position: freeSpot(
      point,
      devices.map((device) => device.position),
    ),
    existingNames: devices.map((device) => device.config.hostname),
  });
  const result = editor.addDevice(spec);
  if (result.ok) editorStore.getState().select({ devices: [result.value] });
}

/** What R, S and P add: the first model of each kind in the catalog. */
export const QUICK_ADD = {
  addRouter: { model: 'router-2g2s', label: 'router', icon: RouterIcon },
  addSwitch: { model: 'switch-24', label: 'switch', icon: EthernetPortIcon },
  addPc: { model: 'pc', label: 'PC', icon: MonitorIcon },
} as const satisfies Record<string, { model: DeviceModelId; label: string; icon: LucideIcon }>;

/** Adds an annotation at a flow point: drafts for typing tools, default boxes for draw tools. */
export function addAnnotationAt(tool: AnnotationTool, at: Point) {
  if (isDrawTool(tool)) placeAnnotation(tool, at);
  else startTyping(tool, at);
}

/** What N, T, B and O do: typing tools start under the pointer, draw tools arm for a drag. */
export function pickAnnotationTool(tool: AnnotationTool) {
  if (isDrawTool(tool)) return toggleDrawTool(tool);
  const point = pointerOrCentre();
  if (point) startTyping(tool, point);
}

export function autoLayoutAndFit() {
  void autoLayout({ duration: motion() * 1.5 }).then(fitView);
}

/** Esc on the canvas. True when it was used, so the shell leaves focus mode only otherwise. */
export function canvasEscape(): boolean {
  if (canvasUi.getState().drawing) {
    canvasUi.setState({ drawing: null });
    return true;
  }
  return cableTool.getState().escape();
}

const selectedDevice = (): DeviceId | undefined => {
  const { devices } = editorStore.getState().selection;
  return devices.length === 1 ? devices[0] : undefined;
};

function renameSelected() {
  const device = selectedDevice();
  if (device) startRename(device);
}

type CanvasShortcutId = Extract<
  ShortcutId,
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
  | 'addNote'
  | 'addText'
  | 'addArea'
  | 'addEllipse'
>;

type KeyPress = Pick<KeyboardEvent, 'key' | 'shiftKey'>;

export const canvasShortcuts: Record<CanvasShortcutId, (event?: KeyPress) => void> = {
  fitView,
  zoomIn: () => zoomBy('in'),
  zoomOut: () => zoomBy('out'),
  selectTool: stopTools,
  cableTool: toggleCableTool,
  deleteSelection,
  selectAll,
  copy: copySelection,
  cut: cutSelection,
  paste: () => paste(),
  duplicate: duplicateSelection,
  nudge,
  rename: renameSelected,
  addRouter: () => placeDevice(QUICK_ADD.addRouter.model, pointerOrCentre()),
  addSwitch: () => placeDevice(QUICK_ADD.addSwitch.model, pointerOrCentre()),
  addPc: () => placeDevice(QUICK_ADD.addPc.model, pointerOrCentre()),
  addNote: () => pickAnnotationTool('note'),
  addText: () => pickAnnotationTool('text'),
  addArea: () => pickAnnotationTool('area'),
  addEllipse: () => pickAnnotationTool('ellipse'),
};

const PORT_LABELS_KEY = 'tracer.canvas.portLabels';

const prefs = createStore(() => ({
  portLabels: readJson(PORT_LABELS_KEY, (v) => (typeof v === 'boolean' ? v : undefined)) ?? true,
}));

export const usePortLabels = () => useStore(prefs, (state) => state.portLabels);

export function togglePortLabels() {
  const portLabels = !prefs.getState().portLabels;
  prefs.setState({ portLabels });
  safeStorage.setItem(PORT_LABELS_KEY, JSON.stringify(portLabels));
}

const deviceCount = () => Object.keys(editorStore.getState().topology.devices).length;
const hasDevices = () => deviceCount() > 0;
const hasCopyable = () => {
  const { devices, annotations } = editorStore.getState().selection;
  return devices.length + annotations.length > 0;
};

export const ALIGN_LABELS: Record<AlignEdge, { title: string; icon: LucideIcon }> = {
  left: { title: 'Align left', icon: AlignStartVerticalIcon },
  centre: { title: 'Align centres', icon: AlignCenterVerticalIcon },
  right: { title: 'Align right', icon: AlignEndVerticalIcon },
  top: { title: 'Align top', icon: AlignStartHorizontalIcon },
  middle: { title: 'Align middles', icon: AlignCenterHorizontalIcon },
  bottom: { title: 'Align bottom', icon: AlignEndHorizontalIcon },
};

export const DISTRIBUTE_LABELS: Record<Axis, { title: string; icon: LucideIcon }> = {
  horizontal: { title: 'Distribute horizontally', icon: AlignHorizontalDistributeCenterIcon },
  vertical: { title: 'Distribute vertically', icon: AlignVerticalDistributeCenterIcon },
};

const ANNOTATION_KEYWORDS: Record<AnnotationTool, string[]> = {
  note: ['sticky', 'comment', 'text'],
  text: ['heading', 'title', 'caption', 'words'],
  area: ['region', 'zone', 'group', 'building', 'vlan', 'room', 'box'],
  rectangle: ['shape', 'square', 'box', 'outline'],
  ellipse: ['shape', 'circle', 'oval', 'outline', 'cloud'],
};

export const canvasCommands: readonly Command[] = [
  {
    id: 'edit.copy',
    title: 'Copy',
    group: 'Edit',
    keywords: ['clipboard', 'devices', 'annotations'],
    icon: CopyIcon,
    shortcut: 'copy',
    enabled: hasCopyable,
    run: copySelection,
  },
  {
    id: 'edit.cut',
    title: 'Cut',
    group: 'Edit',
    keywords: ['clipboard', 'move'],
    icon: ScissorsIcon,
    shortcut: 'cut',
    enabled: hasCopyable,
    run: cutSelection,
  },
  {
    id: 'edit.paste',
    title: 'Paste',
    group: 'Edit',
    keywords: ['clipboard'],
    icon: ClipboardPasteIcon,
    shortcut: 'paste',
    enabled: canPaste,
    run: () => paste(),
  },
  {
    id: 'edit.duplicate',
    title: 'Duplicate',
    group: 'Edit',
    keywords: ['copy', 'clone'],
    icon: CopyPlusIcon,
    shortcut: 'duplicate',
    enabled: hasCopyable,
    run: duplicateSelection,
  },
  {
    id: 'edit.selectAll',
    title: 'Select all',
    group: 'Edit',
    keywords: ['devices', 'links', 'annotations', 'everything'],
    icon: SquareDashedMousePointerIcon,
    shortcut: 'selectAll',
    enabled: () =>
      hasDevices() || Object.keys(editorStore.getState().topology.annotations).length > 0,
    run: selectAll,
  },
  {
    id: 'edit.deleteSelection',
    title: 'Delete selection',
    group: 'Edit',
    keywords: ['remove', 'devices', 'links', 'cables', 'annotations'],
    icon: Trash2Icon,
    shortcut: 'deleteSelection',
    enabled: hasSelection,
    run: deleteSelection,
  },
  {
    id: 'edit.rename',
    title: 'Rename device',
    group: 'Edit',
    keywords: ['hostname', 'name'],
    icon: PencilIcon,
    shortcut: 'rename',
    enabled: () => selectedDevice() !== undefined,
    run: renameSelected,
  },
  {
    id: 'edit.cableTool',
    title: 'Cable tool',
    group: 'Edit',
    keywords: ['connect', 'link', 'wire', 'straight', 'crossover', 'serial'],
    icon: CableIcon,
    shortcut: 'cableTool',
    run: toggleCableTool,
  },
  ...(Object.keys(QUICK_ADD) as (keyof typeof QUICK_ADD)[]).map((id): Command => ({
    id: `edit.${id}`,
    title: `Add ${QUICK_ADD[id].label}`,
    group: 'Edit',
    keywords: ['device', 'new', 'place'],
    icon: QUICK_ADD[id].icon,
    shortcut: id,
    run: canvasShortcuts[id],
  })),
  ...(Object.keys(ANNOTATION_TOOLS) as AnnotationTool[]).map((tool): Command => {
    const { label, icon, shortcut } = ANNOTATION_TOOLS[tool];
    return {
      id: `edit.add${tool.charAt(0).toUpperCase()}${tool.slice(1)}`,
      title: isDrawTool(tool) ? `Draw ${label.toLowerCase()}` : `Add ${label.toLowerCase()}`,
      group: 'Edit',
      keywords: ['annotation', 'label', 'document', ...ANNOTATION_KEYWORDS[tool]],
      icon,
      shortcut,
      run: () => pickAnnotationTool(tool),
    };
  }),
  ...ALIGN_EDGES.map((edge): Command => ({
    id: `arrange.align.${edge}`,
    title: ALIGN_LABELS[edge].title,
    group: 'Arrange',
    keywords: ['align', 'line up', 'devices'],
    icon: ALIGN_LABELS[edge].icon,
    enabled: canAlign,
    run: () => align(edge),
  })),
  ...(['horizontal', 'vertical'] as const).map((axis): Command => ({
    id: `arrange.distribute.${axis}`,
    title: DISTRIBUTE_LABELS[axis].title,
    group: 'Arrange',
    keywords: ['space', 'spacing', 'even', 'devices'],
    icon: DISTRIBUTE_LABELS[axis].icon,
    enabled: canDistribute,
    run: () => distribute(axis),
  })),
  {
    id: 'arrange.autoLayout',
    title: 'Auto-layout',
    group: 'Arrange',
    keywords: ['tidy', 'arrange', 'layout', 'organise', 'organize', 'clean up', 'elk'],
    icon: WorkflowIcon,
    enabled: () => deviceCount() >= 2,
    run: autoLayoutAndFit,
  },
  {
    id: 'view.fitView',
    title: 'Fit view',
    group: 'View',
    keywords: ['zoom to fit', 'frame', 'all devices'],
    icon: ScanIcon,
    shortcut: 'fitView',
    enabled: hasDevices,
    run: fitView,
  },
  {
    id: 'view.zoomIn',
    title: 'Zoom in',
    group: 'View',
    keywords: ['magnify', 'bigger'],
    icon: ZoomInIcon,
    shortcut: 'zoomIn',
    run: () => zoomBy('in'),
  },
  {
    id: 'view.zoomOut',
    title: 'Zoom out',
    group: 'View',
    keywords: ['smaller'],
    icon: ZoomOutIcon,
    shortcut: 'zoomOut',
    run: () => zoomBy('out'),
  },
  {
    id: 'view.actualSize',
    title: 'Zoom to 100%',
    group: 'View',
    keywords: ['actual size', 'reset zoom'],
    icon: FullscreenIcon,
    run: zoomToActualSize,
  },
  {
    id: 'view.portLabels',
    title: 'Toggle port labels',
    group: 'View',
    keywords: ['interfaces', 'cables', 'links', 'names'],
    icon: TagIcon,
    run: togglePortLabels,
  },
];
