import '@xyflow/react/dist/base.css';
import './canvas.css';
import {
  Background,
  BackgroundVariant,
  ConnectionLineType,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  SelectionMode,
  useKeyPress,
  useReactFlow,
  useStore,
  type ColorMode,
  type Connection,
  type EdgeChange,
  type MiniMapNodeProps,
  type NodeChange,
  type NodeMouseHandler,
  type ReactFlowInstance,
} from '@xyflow/react';
import { NetworkIcon } from 'lucide-react';
import {
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type DragEvent,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { formatShortcut } from '@/app/shell/shortcuts';
import { findDeviceModel, type DeviceModelId } from '@/devices/catalog';
import { useRegisterCommands } from '@/features/command/registry';
import { openDeviceConsole } from '@/features/inspector/requests';
import { DEVICE_DRAG_TYPE, NOTE_DRAG_TYPE } from '@/features/palette/PalettePanel';
import type { AnnotationId, DeviceId, LinkId } from '@/model';
import { useEditor } from '@/model/react';
import { editorStore } from '@/model/store';
import { cn } from '@/ui/cn';
import { EmptyState } from '@/ui/empty-state';
import { CableEdge } from './CableEdge';
import { CanvasContextMenu, type MenuTarget } from './CanvasContextMenu';
import { ToolHint, Toolbar, ZoomControls } from './CanvasControls';
import { cableTool, useCableTool } from './cableTool';
import { useCanvasUi } from './canvasUi';
import {
  attachCanvas,
  canvasCommands,
  FIT_VIEW,
  placeDevice,
  trackPointer,
  usePortLabels,
} from './controller';
import { DeviceNode } from './DeviceNode';
import { currentSelection, editNote, setSelection, startNote } from './edit';
import {
  applySelectChanges,
  createEdgeMapper,
  createNodeMapper,
  createNoteMapper,
  isDeviceId,
  isNoteId,
  movesFrom,
  usedPortCounts,
  type CableFlowEdge,
  type CanvasNode,
} from './flow';
import { GRID } from './geometry';
import { NoteNode } from './NoteNode';
import { PortPicker } from './PortPicker';

const NODE_TYPES = { device: DeviceNode, note: NoteNode };
const EDGE_TYPES = { cable: CableEdge };
const MULTI_SELECT_KEYS = ['Shift', 'Meta', 'Control'];
const MIDDLE_BUTTON = [1];
const MINIMAP_SIZE = { width: 176, height: 112 };

// React Flow reports what the user did; the store decides. Moves only come from drags, which a
// gesture brackets into one undo step (arrow keys go through `nudge`). Device and link selection
// lives in the store for the inspector, note selection in the canvas's own state.
function onNodesChange(changes: NodeChange<CanvasNode>[]) {
  const { devices, notes } = movesFrom(changes);
  if (devices.length > 0) editorStore.getState().moveDevices(devices);
  if (notes.length > 0) editorStore.getState().moveAnnotations(notes);
  const selection = currentSelection();
  const selectedDevices = applySelectChanges<DeviceId>(selection.devices, changes, isDeviceId);
  const selectedNotes = applySelectChanges<AnnotationId>(selection.notes, changes, isNoteId);
  if (selectedDevices || selectedNotes) {
    setSelection({
      ...selection,
      devices: selectedDevices ?? selection.devices,
      notes: selectedNotes ?? selection.notes,
    });
  }
}

function onEdgesChange(changes: EdgeChange<CableFlowEdge>[]) {
  const { selection, select } = editorStore.getState();
  const links = applySelectChanges<LinkId>(selection.links, changes);
  if (links) select({ ...selection, links });
}

const beginGesture = () => editorStore.getState().beginGesture();
const endGesture = () => editorStore.getState().endGesture();

const onNodeClick: NodeMouseHandler<CanvasNode> = (_, node) => {
  if (isDeviceId(node.id)) cableTool.getState().clickDevice(node.id);
};

// Double-click opens a device's CLI or Desktop, as the UI/UX doc has it, and edits a note.
const onNodeDoubleClick: NodeMouseHandler<CanvasNode> = (_, node) => {
  if (cableTool.getState().step) return;
  if (isDeviceId(node.id)) openDeviceConsole(node.id);
  else if (isNoteId(node.id)) editNote(node.id);
};

// Quick cable ends on another device's tile, which is a target handle while a drag is on.
function onConnect({ source, target }: Connection) {
  if (isDeviceId(source) && isDeviceId(target)) cableTool.getState().quickConnect(source, target);
}

const DROP_TYPES = [DEVICE_DRAG_TYPE, NOTE_DRAG_TYPE];

function onDragOver(event: DragEvent) {
  if (!DROP_TYPES.some((type) => event.dataTransfer.types.includes(type))) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
}

// Fit once when the canvas opens on an existing lab. React Flow's own fitView prop would instead
// wait for the first nodes and re-centre the view under the first device dropped.
function fitOnOpen(flow: ReactFlowInstance<CanvasNode, CableFlowEdge>) {
  if (flow.getNodes().length > 0) void flow.fitView(FIT_VIEW);
}

// React Flow tags its root with a colour mode class, and the design tokens re-scope on `.light`
// and `.dark`, so the tag must match the theme on <html>.
const themeClass = (): ColorMode =>
  document.documentElement.classList.contains('dark') ? 'dark' : 'light';

function subscribeTheme(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  return () => observer.disconnect();
}

const minimapColor = (node: CanvasNode) =>
  node.selected ? 'var(--accent)' : node.type === 'note' ? 'var(--note-edge)' : 'var(--text-3)';

function MinimapNode({ x, y, width, height, color, selected }: MiniMapNodeProps) {
  return (
    <rect
      className={cn('react-flow__minimap-node', selected && 'selected')}
      x={x}
      y={y}
      width={width}
      height={height}
      rx={10}
      style={{ fill: color }}
    />
  );
}

function useNodes(): CanvasNode[] {
  const devices = useEditor((state) => state.topology.devices);
  const links = useEditor((state) => state.topology.links);
  const annotations = useEditor((state) => state.topology.annotations);
  const selection = useEditor((state) => state.selection);
  const notes = useCanvasUi((state) => state.notes);
  const edit = useCanvasUi((state) => state.edit);

  const [toNodes] = useState(createNodeMapper);
  const [toNotes] = useState(createNoteMapper);
  const used = useMemo(() => usedPortCounts(links), [links]);
  const selectedDevices = useMemo(() => new Set(selection.devices), [selection.devices]);
  const selectedNotes = useMemo(() => new Set(notes), [notes]);
  const deviceNodes = useMemo(
    () => toNodes(devices, used, selectedDevices),
    [toNodes, devices, used, selectedDevices],
  );
  const editing = edit?.kind === 'note' ? edit.note : undefined;
  const draft = edit?.kind === 'new-note' ? edit.position : undefined;
  const noteNodes = useMemo(
    () => toNotes(annotations, selectedNotes, editing, draft),
    [toNotes, annotations, selectedNotes, editing, draft],
  );
  // Notes first, so devices draw over them.
  return useMemo(() => [...noteNodes, ...deviceNodes], [noteNodes, deviceNodes]);
}

function Flow({ element }: { element: RefObject<HTMLElement | null> }) {
  const devices = useEditor((state) => state.topology.devices);
  const links = useEditor((state) => state.topology.links);
  const selection = useEditor((state) => state.selection);
  const cabling = useCableTool((state) => state.step !== null);
  const editingText = useCanvasUi((state) => state.edit !== null);
  const portLabels = usePortLabels();
  const zoomedOut = useStore((state) => state.transform[2] < 0.5);
  const sparseGrid = useStore((state) => state.transform[2] < 0.6);
  const connecting = useStore((state) => state.connection.inProgress);
  const altHeld = useKeyPress('Alt');
  const colorMode = useSyncExternalStore(subscribeTheme, themeClass);
  const flow = useReactFlow<CanvasNode, CableFlowEdge>();
  const [menu, setMenu] = useState<MenuTarget | null>(null);

  const nodes = useNodes();
  const [toEdges] = useState(createEdgeMapper);
  const selectedLinks = useMemo(() => new Set(selection.links), [selection.links]);
  const edges = useMemo(
    () => toEdges(links, devices, selectedLinks),
    [toEdges, links, devices, selectedLinks],
  );

  useEffect(() => {
    const canvas = element.current;
    return canvas ? attachCanvas({ flow, element: canvas }) : undefined;
  }, [flow, element]);
  useRegisterCommands(canvasCommands);

  // A different lab (opened, restored or new) starts fitted. Edits keep the lab's createdAt.
  const lab = useEditor((state) => state.topology.meta.createdAt);
  useEffect(() => {
    if (flow.viewportInitialized) fitOnOpen(flow);
  }, [flow, lab]);

  const flowPoint = (event: { clientX: number; clientY: number }) =>
    flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });

  const onDrop = (event: DragEvent) => {
    const note = event.dataTransfer.types.includes(NOTE_DRAG_TYPE);
    const model = findDeviceModel(event.dataTransfer.getData(DEVICE_DRAG_TYPE));
    if (!note && !model) return;
    event.preventDefault();
    element.current?.focus({ preventScroll: true });
    if (model) placeDevice(model.id as DeviceModelId, flowPoint(event));
    else startNote(flowPoint(event));
  };

  // Right-click acts on the selection when the element under the pointer is part of it, and on
  // that element alone otherwise, as file managers and design tools do.
  const openMenu = (target: MenuTarget) => {
    cableTool.getState().exit();
    setMenu(target);
  };
  const onNodeContextMenu = (event: MouseEvent, node: CanvasNode) => {
    const selected = currentSelection();
    const inSelection = isDeviceId(node.id)
      ? selected.devices.includes(node.id)
      : isNoteId(node.id) && selected.notes.includes(node.id);
    const count = selected.devices.length + selected.links.length + selected.notes.length;
    const at = flowPoint(event);
    if (inSelection && count > 1) return openMenu({ kind: 'selection', at });
    if (isDeviceId(node.id)) {
      setSelection({ devices: [node.id], links: [], notes: [] });
      openMenu({ kind: 'device', device: node.id, at });
    } else if (isNoteId(node.id)) {
      setSelection({ devices: [], links: [], notes: [node.id] });
      openMenu({ kind: 'note', note: node.id, at });
    } else {
      event.preventDefault();
    }
  };
  const onEdgeContextMenu = (event: MouseEvent, edge: CableFlowEdge) => {
    setSelection({ devices: [], links: [edge.id as LinkId], notes: [] });
    openMenu({ kind: 'link', link: edge.id as LinkId, at: flowPoint(event) });
  };

  return (
    <CanvasContextMenu target={menu}>
      <div
        className="size-full"
        onPointerMove={(event) => trackPointer(event)}
        onPointerLeave={() => trackPointer(null)}
      >
        <ReactFlow<CanvasNode, CableFlowEdge>
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeDragStart={beginGesture}
          onNodeDragStop={endGesture}
          onSelectionDragStart={beginGesture}
          onSelectionDragStop={endGesture}
          onNodeClick={onNodeClick}
          onNodeDoubleClick={onNodeDoubleClick}
          onConnect={onConnect}
          onNodeContextMenu={onNodeContextMenu}
          onEdgeContextMenu={onEdgeContextMenu}
          onSelectionContextMenu={(event) => openMenu({ kind: 'selection', at: flowPoint(event) })}
          onPaneContextMenu={(event) => openMenu({ kind: 'pane', at: flowPoint(event) })}
          onDragOver={onDragOver}
          onDrop={onDrop}
          nodeOrigin={[0.5, 0.5]}
          snapToGrid={!altHeld}
          snapGrid={[GRID, GRID]}
          nodesDraggable={!cabling}
          nodesConnectable={!cabling && !editingText}
          connectOnClick={false}
          connectionLineType={ConnectionLineType.Straight}
          connectionRadius={0}
          elementsSelectable={!cabling}
          selectionOnDrag={!cabling}
          selectionMode={SelectionMode.Partial}
          multiSelectionKeyCode={MULTI_SELECT_KEYS}
          panOnDrag={cabling || MIDDLE_BUTTON}
          panOnScroll
          deleteKeyCode={null}
          zoomOnDoubleClick={false}
          minZoom={0.2}
          maxZoom={2.5}
          onInit={fitOnOpen}
          colorMode={colorMode}
          proOptions={{ hideAttribution: true }}
          className={cn(
            cabling && 'is-cabling',
            connecting && 'is-connecting',
            zoomedOut && 'is-zoomed-out',
            !portLabels && 'hide-port-labels',
          )}
        >
          <Background
            variant={BackgroundVariant.Dots}
            gap={sparseGrid ? GRID * 4 : GRID}
            size={1.25}
          />
          <Panel position="top-center">
            <Toolbar />
          </Panel>
          <Panel position="bottom-right" style={{ marginRight: MINIMAP_SIZE.width + 20 }}>
            <ZoomControls />
          </Panel>
          <MiniMap
            position="bottom-right"
            ariaLabel="Minimap"
            pannable
            zoomable
            nodeColor={minimapColor}
            nodeComponent={MinimapNode}
            maskStrokeWidth={1.5}
            offsetScale={12}
            style={MINIMAP_SIZE}
          />
        </ReactFlow>
      </div>
    </CanvasContextMenu>
  );
}

function EmptyCanvasHint() {
  const empty = useEditor((state) => Object.keys(state.topology.devices).length === 0);
  if (!empty) return null;
  return (
    <div className="pointer-events-none absolute inset-0 z-[5] flex items-center justify-center">
      <EmptyState
        icon={NetworkIcon}
        title="Your lab is empty"
        className="rounded-xl bg-surface-0/80 backdrop-blur-[2px]"
      >
        Drag a device from the palette, or click one to drop it here. Press{' '}
        {formatShortcut('commandPalette')} for every command.
      </EmptyState>
    </div>
  );
}

type CanvasFlowProps = { element: RefObject<HTMLElement | null>; children?: ReactNode };

/** Everything that needs React Flow, loaded after the shell so the first paint stays small. */
export default function CanvasFlow({ element, children }: CanvasFlowProps) {
  return (
    <ReactFlowProvider>
      <Flow element={element} />
      <EmptyCanvasHint />
      <div className="pointer-events-none absolute inset-x-0 bottom-16 z-10 flex flex-col items-center gap-2 px-4 *:pointer-events-auto">
        <ToolHint />
        {children}
      </div>
      <PortPicker canvas={element} />
    </ReactFlowProvider>
  );
}
