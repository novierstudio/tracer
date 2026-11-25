import '@xyflow/react/dist/base.css';
import './canvas.css';
import {
  Background,
  BackgroundVariant,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  SelectionMode,
  useKeyPress,
  useReactFlow,
  useStore,
  type ColorMode,
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
  useRef,
  useState,
  useSyncExternalStore,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { formatShortcut } from '@/app/shell/shortcuts';
import { findDeviceModel, type DeviceModelId } from '@/devices/catalog';
import { useRegisterCommands } from '@/features/command/registry';
import { DEVICE_DRAG_TYPE } from '@/features/palette/PalettePanel';
import type { DeviceId, LinkId } from '@/model';
import { useEditor } from '@/model/react';
import { editorStore } from '@/model/store';
import { cn } from '@/ui/cn';
import { EmptyState } from '@/ui/empty-state';
import { CableEdge } from './CableEdge';
import { ToolHint, Toolbar, ZoomControls } from './CanvasControls';
import { cableTool, useCableTool } from './cableTool';
import { attachCanvas, canvasCommands, FIT_VIEW, placeDevice, usePortLabels } from './controller';
import { DeviceNode } from './DeviceNode';
import {
  applySelectChanges,
  createEdgeMapper,
  createNodeMapper,
  movesFrom,
  usedPortCounts,
  type CableFlowEdge,
  type DeviceFlowNode,
} from './flow';
import { GRID } from './geometry';
import { PortPicker } from './PortPicker';

const NODE_TYPES = { device: DeviceNode };
const EDGE_TYPES = { cable: CableEdge };
const MULTI_SELECT_KEYS = ['Shift', 'Meta', 'Control'];
const MIDDLE_BUTTON = [1];
const MINIMAP_SIZE = { width: 176, height: 112 };

// React Flow reports what the user did; the store decides. Moves go through moveDevices (one undo
// step per drag, bracketed by a gesture) and selection lives in the store for the inspector.
function onNodesChange(changes: NodeChange<DeviceFlowNode>[]) {
  const moves = movesFrom(changes);
  if (moves.length > 0) editorStore.getState().moveDevices(moves);
  const { selection, select } = editorStore.getState();
  const devices = applySelectChanges<DeviceId>(selection.devices, changes);
  if (devices) select({ ...selection, devices });
}

function onEdgesChange(changes: EdgeChange<CableFlowEdge>[]) {
  const { selection, select } = editorStore.getState();
  const links = applySelectChanges<LinkId>(selection.links, changes);
  if (links) select({ ...selection, links });
}

const beginGesture = () => editorStore.getState().beginGesture();
const endGesture = () => editorStore.getState().endGesture();

const onNodeClick: NodeMouseHandler<DeviceFlowNode> = (_, node) =>
  cableTool.getState().clickDevice(node.id as DeviceId);

function onDragOver(event: DragEvent) {
  if (!event.dataTransfer.types.includes(DEVICE_DRAG_TYPE)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
}

// Fit once when the canvas opens on an existing lab. React Flow's own fitView prop would instead
// wait for the first nodes and re-centre the view under the first device dropped.
function fitOnOpen(flow: ReactFlowInstance<DeviceFlowNode, CableFlowEdge>) {
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

const minimapColor = (node: DeviceFlowNode) => (node.selected ? 'var(--accent)' : 'var(--text-3)');

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

function Flow({ element }: { element: RefObject<HTMLElement | null> }) {
  const devices = useEditor((state) => state.topology.devices);
  const links = useEditor((state) => state.topology.links);
  const selection = useEditor((state) => state.selection);
  const cabling = useCableTool((state) => state.step !== null);
  const portLabels = usePortLabels();
  const zoomedOut = useStore((state) => state.transform[2] < 0.5);
  const sparseGrid = useStore((state) => state.transform[2] < 0.6);
  const altHeld = useKeyPress('Alt');
  const colorMode = useSyncExternalStore(subscribeTheme, themeClass);
  const flow = useReactFlow<DeviceFlowNode, CableFlowEdge>();

  const [toNodes] = useState(createNodeMapper);
  const [toEdges] = useState(createEdgeMapper);
  const used = useMemo(() => usedPortCounts(links), [links]);
  const selectedDevices = useMemo(() => new Set(selection.devices), [selection.devices]);
  const selectedLinks = useMemo(() => new Set(selection.links), [selection.links]);
  const nodes = useMemo(
    () => toNodes(devices, used, selectedDevices),
    [toNodes, devices, used, selectedDevices],
  );
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

  const onDrop = (event: DragEvent) => {
    const model = findDeviceModel(event.dataTransfer.getData(DEVICE_DRAG_TYPE));
    if (!model) return;
    event.preventDefault();
    element.current?.focus({ preventScroll: true });
    const at = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    placeDevice(model.id as DeviceModelId, at);
  };

  return (
    <ReactFlow<DeviceFlowNode, CableFlowEdge>
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
      onDragOver={onDragOver}
      onDrop={onDrop}
      nodeOrigin={[0.5, 0.5]}
      snapToGrid={!altHeld}
      snapGrid={[GRID, GRID]}
      nodesDraggable={!cabling}
      nodesConnectable={false}
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
        zoomedOut && 'is-zoomed-out',
        !portLabels && 'hide-port-labels',
      )}
    >
      <Background variant={BackgroundVariant.Dots} gap={sparseGrid ? GRID * 4 : GRID} size={1.25} />
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

/** Space or Enter on a focused device picks it for the cable tool, as a click would. */
function onCanvasKeyDown(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  if (!cableTool.getState().step || !(event.target instanceof Element)) return;
  const id = event.target.closest('.react-flow__node')?.getAttribute('data-id');
  if (!id) return;
  event.preventDefault();
  cableTool.getState().clickDevice(id as DeviceId);
}

type CanvasProps = { fullscreen: boolean; children?: ReactNode };

export function Canvas({ fullscreen, children }: CanvasProps) {
  const ref = useRef<HTMLElement>(null);
  return (
    <main
      ref={ref}
      aria-label="Canvas"
      tabIndex={-1}
      onKeyDown={onCanvasKeyDown}
      onPointerDownCapture={(event) => {
        // Canvas-only shortcuts such as Select all need the canvas to hold focus after a click.
        // React also routes events from the portalled port picker here; those must be left alone.
        const canvas = ref.current;
        if (!canvas || !canvas.contains(event.target as Node)) return;
        if (!canvas.contains(document.activeElement)) canvas.focus({ preventScroll: true });
      }}
      className={cn(
        'tracer-canvas overflow-hidden bg-surface-0 outline-none',
        fullscreen ? 'fixed inset-0 z-30' : 'relative h-full',
      )}
    >
      <ReactFlowProvider>
        <Flow element={ref} />
        <EmptyCanvasHint />
        <div className="pointer-events-none absolute inset-x-0 bottom-16 z-10 flex flex-col items-center gap-2 px-4 *:pointer-events-auto">
          <ToolHint />
          {children}
        </div>
        <PortPicker canvas={ref} />
      </ReactFlowProvider>
    </main>
  );
}
