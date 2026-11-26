import '@xyflow/react/dist/base.css';
import './canvas.css';
import {
  ConnectionLineType,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  SelectionMode,
  useKeyPress,
  useReactFlow,
  useStore,
  useStoreApi,
  type ColorMode,
  type Connection,
  type EdgeChange,
  type MiniMapNodeProps,
  type NodeChange,
  type NodeMouseHandler,
  type ReactFlowInstance,
  type ReactFlowState,
} from '@xyflow/react';
import { NetworkIcon } from 'lucide-react';
import {
  useCallback,
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
import { ANNOTATION_DRAG_TYPE, DEVICE_DRAG_TYPE } from '@/features/palette/PalettePanel';
import { TrafficOverlay } from '@/features/simulation/TrafficOverlay';
import type { AnnotationId, AnnotationKind, DeviceId, LinkId } from '@/model';
import { useEditor } from '@/model/react';
import { editorStore } from '@/model/store';
import { cn } from '@/ui/cn';
import { EmptyState } from '@/ui/empty-state';
import { AreaNode, NoteNode, ShapeNode, TextNode } from './AnnotationNodes';
import { ANNOTATION_KINDS, ANNOTATION_TOOLS, type AnnotationTool } from './annotations';
import { CableEdge } from './CableEdge';
import { CanvasContextMenu, type MenuTarget } from './CanvasContextMenu';
import { ToolHint, Toolbar, ZoomControls } from './CanvasControls';
import { cableTool, useCableTool } from './cableTool';
import { useCanvasUi } from './canvasUi';
import {
  addAnnotationAt,
  attachCanvas,
  canvasCommands,
  FIT_VIEW,
  lastPointer,
  placeDevice,
  trackPointer,
  usePortLabels,
} from './controller';
import { DeviceNode } from './DeviceNode';
import { DrawLayer } from './DrawLayer';
import { editText, resizeAnnotation, stopTools } from './edit';
import {
  applySelectChanges,
  createAnnotationMapper,
  createEdgeMapper,
  createNodeMapper,
  isAnnotationId,
  isDeviceId,
  movesFrom,
  resizesFrom,
  usedPortCounts,
  type CableFlowEdge,
  type CanvasNode,
} from './flow';
import { GRID } from './geometry';
import { PortPicker } from './PortPicker';

const NODE_TYPES = {
  device: DeviceNode,
  note: NoteNode,
  text: TextNode,
  area: AreaNode,
  shape: ShapeNode,
} satisfies Record<CanvasNode['type'] & string, unknown>;
const EDGE_TYPES = { cable: CableEdge };
const MULTI_SELECT_KEYS = ['Shift', 'Meta', 'Control'];
const MIDDLE_BUTTON = [1];
const MINIMAP_SIZE = { width: 176, height: 112 };

// React Flow reports what the user did; the store decides. Moves only come from drags, which a
// gesture brackets into one undo step (arrow keys go through `nudge`), and resizes from resize
// handles, which bracket theirs. Selection lives in the store for the inspector.
function applyNodeChanges(changes: NodeChange<CanvasNode>[]) {
  const { devices, annotations } = movesFrom(changes);
  const resizes = resizesFrom(changes);
  const editor = editorStore.getState();
  if (devices.length > 0) editor.moveDevices(devices);
  const resizing = new Set(resizes.map((resize) => resize.annotation));
  const moves = annotations.filter((move) => !resizing.has(move.annotation));
  if (moves.length > 0) editor.moveAnnotations(moves);
  for (const { annotation, width, height } of resizes) {
    const position = annotations.find((move) => move.annotation === annotation)?.position;
    resizeAnnotation(annotation, { position, width, height });
  }
  const { selection } = editorStore.getState();
  const selectedDevices = applySelectChanges<DeviceId>(selection.devices, changes, isDeviceId);
  const selectedAnnotations = applySelectChanges<AnnotationId>(
    selection.annotations,
    changes,
    isAnnotationId,
  );
  if (selectedDevices || selectedAnnotations) {
    editor.select({
      ...selection,
      devices: selectedDevices ?? selection.devices,
      annotations: selectedAnnotations ?? selection.annotations,
    });
  }
}

const isFrameNode = (type: string | undefined) =>
  type !== undefined && type in ANNOTATION_KINDS && ANNOTATION_KINDS[type as AnnotationKind].frame;

/**
 * A box selection picks a frame (an area box or shape) only when it covers all of it, so dragging
 * a box around two devices inside "Building A" selects the devices and not the building. React
 * Flow keeps the box's start in flow units while the drag is on; the pointer gives its other end.
 */
function framesOutsideBox(
  changes: readonly NodeChange<CanvasNode>[],
  state: ReactFlowState<CanvasNode, CableFlowEdge>,
  toFlow: (point: { x: number; y: number }) => { x: number; y: number },
): Set<string> {
  const outside = new Set<string>();
  const rect = state.userSelectionRect;
  const pointer = lastPointer();
  if (!rect || !pointer) return outside;
  const end = toFlow(pointer);
  const left = Math.min(rect.startX, end.x);
  const right = Math.max(rect.startX, end.x);
  const top = Math.min(rect.startY, end.y);
  const bottom = Math.max(rect.startY, end.y);
  for (const change of changes) {
    if (change.type !== 'select' || !change.selected) continue;
    const node = state.nodeLookup.get(change.id);
    if (!node || !isFrameNode(node.type)) continue;
    const { x, y } = node.internals.positionAbsolute;
    const { width = 0, height = 0 } = node.measured;
    if (x < left || y < top || x + width > right || y + height > bottom) outside.add(change.id);
  }
  return outside;
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

// Double-click opens a device's CLI or Desktop, as the UI/UX doc has it, and edits an annotation's
// text.
const onNodeDoubleClick: NodeMouseHandler<CanvasNode> = (_, node) => {
  if (cableTool.getState().step) return;
  if (isDeviceId(node.id)) openDeviceConsole(node.id);
  else if (isAnnotationId(node.id)) editText(node.id);
};

// Quick cable ends on another device's tile, which is a target handle while a drag is on.
function onConnect({ source, target }: Connection) {
  if (isDeviceId(source) && isDeviceId(target)) cableTool.getState().quickConnect(source, target);
}

const DROP_TYPES = [DEVICE_DRAG_TYPE, ANNOTATION_DRAG_TYPE];

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

const minimapColor = (node: CanvasNode) => {
  if (node.selected) return 'var(--accent)';
  return node.type === 'device'
    ? 'var(--text-3)'
    : `var(--annotation-${node.data.annotation.color})`;
};

const minimapClass = (node: CanvasNode) => `minimap-${node.type}`;

function MinimapNode({ x, y, width, height, color, selected, className }: MiniMapNodeProps) {
  return (
    <rect
      className={cn('react-flow__minimap-node', className, selected && 'selected')}
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
  const edit = useCanvasUi((state) => state.edit);

  const [toNodes] = useState(createNodeMapper);
  const [toAnnotations] = useState(createAnnotationMapper);
  const used = useMemo(() => usedPortCounts(links), [links]);
  const selectedDevices = useMemo(() => new Set(selection.devices), [selection.devices]);
  const selectedAnnotations = useMemo(
    () => new Set(selection.annotations),
    [selection.annotations],
  );
  const deviceNodes = useMemo(
    () => toNodes(devices, used, selectedDevices),
    [toNodes, devices, used, selectedDevices],
  );
  const editing = edit?.kind === 'annotation' ? edit.annotation : undefined;
  const draft = edit?.kind === 'new' ? edit.annotation : undefined;
  const annotationNodes = useMemo(
    () => toAnnotations(annotations, selectedAnnotations, editing, draft),
    [toAnnotations, annotations, selectedAnnotations, editing, draft],
  );
  // Annotations first, so devices draw over them.
  return useMemo(() => [...annotationNodes, ...deviceNodes], [annotationNodes, deviceNodes]);
}

function Flow({ element }: { element: RefObject<HTMLElement | null> }) {
  const devices = useEditor((state) => state.topology.devices);
  const links = useEditor((state) => state.topology.links);
  const selection = useEditor((state) => state.selection);
  const cabling = useCableTool((state) => state.step !== null);
  const editingText = useCanvasUi((state) => state.edit !== null);
  const drawing = useCanvasUi((state) => state.drawing !== null);
  const storeApi = useStoreApi<CanvasNode, CableFlowEdge>();
  const portLabels = usePortLabels();
  const zoomedOut = useStore((state) => state.transform[2] < 0.5);
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

  // The view's zoom as a CSS variable on the canvas, for type that must stay readable zoomed out.
  useEffect(() => {
    const canvas = element.current;
    if (!canvas) return undefined;
    const write = (zoom: number) => canvas.style.setProperty('--zoom', String(zoom));
    write(storeApi.getState().transform[2]);
    return storeApi.subscribe((state, previous) => {
      if (state.transform[2] !== previous.transform[2]) write(state.transform[2]);
    });
  }, [storeApi, element]);

  const onNodesChange = useCallback(
    (changes: NodeChange<CanvasNode>[]) => {
      const outside = framesOutsideBox(changes, storeApi.getState(), flow.screenToFlowPosition);
      applyNodeChanges(
        outside.size === 0
          ? changes
          : changes.filter((change) => !(change.type === 'select' && outside.has(change.id))),
      );
    },
    [storeApi, flow],
  );

  // A different lab (opened, restored or new) starts fitted. Edits keep the lab's createdAt.
  const lab = useEditor((state) => state.topology.meta.createdAt);
  useEffect(() => {
    if (flow.viewportInitialized) fitOnOpen(flow);
  }, [flow, lab]);

  const flowPoint = (event: { clientX: number; clientY: number }) =>
    flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });

  const onDrop = (event: DragEvent) => {
    const tool = event.dataTransfer.getData(ANNOTATION_DRAG_TYPE);
    const annotation = tool in ANNOTATION_TOOLS ? (tool as AnnotationTool) : undefined;
    const model = findDeviceModel(event.dataTransfer.getData(DEVICE_DRAG_TYPE));
    if (!annotation && !model) return;
    event.preventDefault();
    element.current?.focus({ preventScroll: true });
    if (model) placeDevice(model.id as DeviceModelId, flowPoint(event));
    else if (annotation) addAnnotationAt(annotation, flowPoint(event));
  };

  // Right-click acts on the selection when the element under the pointer is part of it, and on
  // that element alone otherwise, as file managers and design tools do.
  const openMenu = (target: MenuTarget) => {
    stopTools();
    setMenu(target);
  };
  const onNodeContextMenu = (event: MouseEvent, node: CanvasNode) => {
    const { selection, select } = editorStore.getState();
    const inSelection = isDeviceId(node.id)
      ? selection.devices.includes(node.id)
      : isAnnotationId(node.id) && selection.annotations.includes(node.id);
    const count = selection.devices.length + selection.links.length + selection.annotations.length;
    const at = flowPoint(event);
    if (inSelection && count > 1) return openMenu({ kind: 'selection', at });
    if (isDeviceId(node.id)) {
      select({ devices: [node.id] });
      openMenu({ kind: 'device', device: node.id, at });
    } else if (isAnnotationId(node.id)) {
      select({ annotations: [node.id] });
      openMenu({ kind: 'annotation', annotation: node.id, at });
    } else {
      event.preventDefault();
    }
  };
  const onEdgeContextMenu = (event: MouseEvent, edge: CableFlowEdge) => {
    editorStore.getState().select({ links: [edge.id as LinkId] });
    openMenu({ kind: 'link', link: edge.id as LinkId, at: flowPoint(event) });
  };

  return (
    <CanvasContextMenu target={menu}>
      <div
        className="size-full"
        onPointerMoveCapture={(event) => trackPointer(event)}
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
          nodesConnectable={!cabling && !editingText && !drawing}
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
          elevateNodesOnSelect={false}
          zoomOnDoubleClick={false}
          minZoom={0.2}
          maxZoom={2.5}
          onInit={fitOnOpen}
          colorMode={colorMode}
          proOptions={{ hideAttribution: true }}
          className={cn(
            cabling && 'is-cabling',
            drawing && 'is-drawing',
            connecting && 'is-connecting',
            zoomedOut && 'is-zoomed-out',
            !portLabels && 'hide-port-labels',
          )}
        >
          <TrafficOverlay />
          <DrawLayer />
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
            nodeClassName={minimapClass}
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
  const empty = useEditor(
    ({ topology }) =>
      Object.keys(topology.devices).length + Object.keys(topology.annotations).length === 0,
  );
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
