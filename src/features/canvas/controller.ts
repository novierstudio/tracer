import type { ReactFlowInstance } from '@xyflow/react';
import {
  CableIcon,
  FullscreenIcon,
  ScanIcon,
  SquareDashedMousePointerIcon,
  TagIcon,
  Trash2Icon,
  ZoomInIcon,
  ZoomOutIcon,
} from 'lucide-react';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import type { ShortcutId } from '@/app/shell/shortcuts';
import { readJson, safeStorage } from '@/app/storage';
import type { DeviceModelId } from '@/devices/catalog';
import { deviceSpec } from '@/devices/create';
import type { Point } from '@/model';
import { editorStore } from '@/model/store';
import type { Command } from '@/features/command/registry';
import { cableTool } from './cableTool';
import type { CableFlowEdge, DeviceFlowNode } from './flow';
import { GRID } from './geometry';

type CanvasHandle = {
  flow: ReactFlowInstance<DeviceFlowNode, CableFlowEdge>;
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

const snap = (value: number) => Math.round(value / GRID) * GRID;

/** The nearest grid point at or after `point`, stepping diagonally past devices already there. */
function freeSpot(point: Point, taken: readonly Point[]): Point {
  let spot = { x: snap(point.x), y: snap(point.y) };
  const occupied = (p: Point) =>
    taken.some((t) => Math.abs(t.x - p.x) < GRID * 2 && Math.abs(t.y - p.y) < GRID * 2);
  for (let i = 0; i < 50 && occupied(spot); i++)
    spot = { x: spot.x + GRID * 3, y: spot.y + GRID * 3 };
  return spot;
}

/** Adds a device at a flow point, or the middle of the view, named like Packet Tracer does. */
export function placeDevice(model: DeviceModelId, at?: Point) {
  const element = mounted?.element;
  const flow = mounted?.flow;
  if (!element || !flow) return;
  const point =
    at ??
    (() => {
      const rect = element.getBoundingClientRect();
      return flow.screenToFlowPosition({
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      });
    })();
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
  if (result.ok) editor.select({ devices: [result.value], links: [] });
}

export function selectAll() {
  const { topology, select } = editorStore.getState();
  select({
    devices: Object.values(topology.devices).map((device) => device.id),
    links: Object.values(topology.links).map((link) => link.id),
  });
}

/** One undo step, whatever mix of devices and links is selected. */
export function deleteSelection() {
  const editor = editorStore.getState();
  const { devices, links } = editor.selection;
  if (devices.length === 0 && links.length === 0) return;
  editor.beginGesture();
  editor.removeLinks(links);
  editor.removeDevices(devices);
  editor.endGesture();
}

/** Esc on the canvas. True when it was used, so the shell leaves focus mode only otherwise. */
export function canvasEscape(): boolean {
  return cableTool.getState().escape();
}

type CanvasShortcutId = Extract<
  ShortcutId,
  'fitView' | 'zoomIn' | 'zoomOut' | 'selectTool' | 'cableTool' | 'deleteSelection' | 'selectAll'
>;

export const canvasShortcuts: Record<CanvasShortcutId, () => void> = {
  fitView,
  zoomIn: () => zoomBy('in'),
  zoomOut: () => zoomBy('out'),
  selectTool: () => cableTool.getState().exit(),
  cableTool: () => cableTool.getState().toggle(),
  deleteSelection,
  selectAll,
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

const hasDevices = () => Object.keys(editorStore.getState().topology.devices).length > 0;
const hasSelection = () => {
  const { devices, links } = editorStore.getState().selection;
  return devices.length + links.length > 0;
};

export const canvasCommands: readonly Command[] = [
  {
    id: 'edit.selectAll',
    title: 'Select all',
    group: 'Edit',
    keywords: ['devices', 'links', 'everything'],
    icon: SquareDashedMousePointerIcon,
    shortcut: 'selectAll',
    enabled: hasDevices,
    run: selectAll,
  },
  {
    id: 'edit.deleteSelection',
    title: 'Delete selection',
    group: 'Edit',
    keywords: ['remove', 'devices', 'links', 'cables'],
    icon: Trash2Icon,
    shortcut: 'deleteSelection',
    enabled: hasSelection,
    run: deleteSelection,
  },
  {
    id: 'edit.cableTool',
    title: 'Cable tool',
    group: 'Edit',
    keywords: ['connect', 'link', 'wire', 'straight', 'crossover', 'serial'],
    icon: CableIcon,
    shortcut: 'cableTool',
    run: () => cableTool.getState().toggle(),
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
