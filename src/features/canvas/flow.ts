import { Position, type Edge, type EdgeChange, type Node, type NodeChange } from '@xyflow/react';
import { findDeviceModel, type DeviceIconName } from '@/devices/catalog';
import type {
  AnnotationId,
  AnnotationKind,
  AnnotationMove,
  AnnotationSpec,
  Cable,
  Device,
  DeviceId,
  DeviceKind,
  Link,
  LinkId,
  Move,
  Topology,
} from '@/model';
import {
  ANNOTATION_KINDS,
  annotationLabel,
  annotationText,
  drawOrder,
  LAYER_Z,
} from './annotations';
import { CABLE_LABELS, shortPortName } from './cables';
import { TILE, type Size } from './geometry';

export type DeviceNodeData = {
  hostname: string;
  icon: DeviceIconName;
  /** The address the config gives. A DHCP host's comes from the simulation instead. */
  address: string | undefined;
  dhcp: boolean;
  powered: boolean;
  freePorts: number;
  totalPorts: number;
};
export type DeviceFlowNode = Node<DeviceNodeData, 'device'>;

export type AnnotationNodeData<K extends AnnotationKind = AnnotationKind> = {
  annotation: Extract<AnnotationSpec, { kind: K }>;
  editing: boolean;
};
/** Each annotation kind is its own node type, so React Flow picks the component per kind. */
export type AnnotationFlowNode<K extends AnnotationKind = AnnotationKind> = Node<
  AnnotationNodeData<K>,
  K
>;

export type CanvasNode = DeviceFlowNode | AnnotationFlowNode;

/** The node for a note or text being written that is not in the lab yet. */
export const NEW_ANNOTATION_ID = 'annotation-new';

// Sizes shown before React Flow measures a node, so a new note's or text's field is on screen,
// and can take focus, the moment N or T is pressed. A note shows three lines.
const INITIAL_HEIGHT: Record<AnnotationKind, number> = { note: 76, text: 32, area: 0, shape: 0 };
const INITIAL_TEXT_WIDTH = 160;

export type CableEdgeData = { cable: Cable; ports: [a: string, b: string] };
export type CableFlowEdge = Edge<CableEdgeData, 'cable'>;

const KIND_ICON: Record<DeviceKind, DeviceIconName> = {
  router: 'router',
  switch: 'switch',
  pc: 'pc',
  server: 'server',
};

// Edges join tile centres. Declaring the handles and size up front means React Flow never has to
// measure a node before drawing its links.
export const CENTRE_HANDLE = { id: 'centre' } as const;
const CENTRE = {
  ...CENTRE_HANDLE,
  x: TILE / 2,
  y: TILE / 2,
  width: 0,
  height: 0,
  position: Position.Top,
};

// Quick cable starts from a band along each tile edge and ends anywhere on another tile. React
// Flow resets a node's handles to these declared ones whenever the node object changes, so every
// handle DeviceNode renders is listed, with the boxes canvas.css draws.
export const QUICK_BANDS = [
  { id: 'quick-top', position: Position.Top, x: 6, y: -6, width: TILE - 12, height: 10 },
  { id: 'quick-right', position: Position.Right, x: TILE - 4, y: 6, width: 10, height: TILE - 12 },
  {
    id: 'quick-bottom',
    position: Position.Bottom,
    x: 6,
    y: TILE - 4,
    width: TILE - 12,
    height: 10,
  },
  { id: 'quick-left', position: Position.Left, x: -6, y: 6, width: 10, height: TILE - 12 },
] as const;
export const QUICK_TARGET = {
  id: 'quick-in',
  position: Position.Top,
  x: 0,
  y: 0,
  width: TILE,
  height: TILE,
} as const;

const HANDLES = [
  { ...CENTRE, type: 'source' as const },
  { ...CENTRE, type: 'target' as const },
  ...QUICK_BANDS.map((band) => ({ ...band, type: 'source' as const })),
  { ...QUICK_TARGET, type: 'target' as const },
];
const MEASURED = { width: TILE, height: TILE };

/** The first configured IPv4 address, shown under the hostname. */
function address(device: Device): string | undefined {
  switch (device.kind) {
    case 'router':
      return Object.values(device.config.interfaces).find((i) => i.ipv4)?.ipv4?.address;
    case 'pc':
    case 'server':
      return device.config.ipv4.mode === 'static' ? device.config.ipv4.address?.address : undefined;
    default:
      return undefined;
  }
}

function nodeData(device: Device, used: number): DeviceNodeData {
  return {
    hostname: device.config.hostname,
    icon: findDeviceModel(device.model)?.icon ?? KIND_ICON[device.kind],
    address: address(device),
    dhcp: (device.kind === 'pc' || device.kind === 'server') && device.config.ipv4.mode === 'dhcp',
    powered: device.powered,
    freePorts: device.ports.length - used,
    totalPorts: device.ports.length,
  };
}

/** The hostname block under a tile. Estimated from text length so links can avoid it unmeasured. */
export function hostnameLabelSize({ hostname, address, dhcp }: DeviceNodeData): Size {
  // A DHCP host's address is not known here, so make room for a long one.
  const shown = address ?? (dhcp ? '192.168.100.100' : undefined);
  const width = Math.max(hostname.length * 7 + 10, shown ? shown.length * 6.2 + 6 : 0);
  return { width, height: shown ? 32 : 18 };
}

export function usedPortCounts(links: Topology['links']): Map<DeviceId, number> {
  const counts = new Map<DeviceId, number>();
  for (const link of Object.values(links)) {
    for (const { device } of [link.a, link.b]) counts.set(device, (counts.get(device) ?? 0) + 1);
  }
  return counts;
}

type NodeEntry = { device: Device; selected: boolean; used: number; node: DeviceFlowNode };

/**
 * Maps store devices to React Flow nodes, returning the previous node object for every device that
 * did not change. React Flow skips unchanged node objects, so a drag re-renders only what moved.
 */
export function createNodeMapper() {
  let cache = new Map<DeviceId, NodeEntry>();
  return (
    devices: Topology['devices'],
    used: ReadonlyMap<DeviceId, number>,
    selected: ReadonlySet<DeviceId>,
  ): DeviceFlowNode[] => {
    const next = new Map<DeviceId, NodeEntry>();
    const nodes = Object.values(devices).map((device) => {
      const entry = {
        device,
        selected: selected.has(device.id),
        used: used.get(device.id) ?? 0,
      };
      const hit = cache.get(device.id);
      if (
        hit &&
        hit.device === device &&
        hit.selected === entry.selected &&
        hit.used === entry.used
      ) {
        next.set(device.id, hit);
        return hit.node;
      }
      const sameData =
        hit &&
        hit.used === entry.used &&
        hit.device.config === device.config &&
        hit.device.powered === device.powered &&
        hit.device.model === device.model;
      const data = sameData ? hit.node.data : nodeData(device, entry.used);
      const node: DeviceFlowNode = {
        id: device.id,
        type: 'device',
        position: device.position,
        data,
        selected: entry.selected,
        width: TILE,
        height: TILE,
        measured: MEASURED,
        handles: HANDLES,
        ariaLabel: `${data.hostname}, ${device.kind}`,
      };
      next.set(device.id, { ...entry, node });
      return node;
    });
    cache = next;
    return nodes;
  };
}

type EdgeEntry = { link: Link; selected: boolean; label: string; edge: CableFlowEdge };

export function createEdgeMapper() {
  let cache = new Map<LinkId, EdgeEntry>();
  return (
    links: Topology['links'],
    devices: Topology['devices'],
    selected: ReadonlySet<LinkId>,
  ): CableFlowEdge[] => {
    const next = new Map<LinkId, EdgeEntry>();
    const edges = Object.values(links).map((link) => {
      const ends = [link.a, link.b].map(
        (end) => `${devices[end.device]?.config.hostname ?? ''} ${shortPortName(end.port)}`,
      );
      const label = `${CABLE_LABELS[link.cable]} cable from ${ends[0]} to ${ends[1]}`;
      const isSelected = selected.has(link.id);
      const hit = cache.get(link.id);
      if (hit && hit.link === link && hit.selected === isSelected && hit.label === label) {
        next.set(link.id, hit);
        return hit.edge;
      }
      const edge: CableFlowEdge = {
        id: link.id,
        type: 'cable',
        source: link.a.device,
        target: link.b.device,
        sourceHandle: CENTRE_HANDLE.id,
        targetHandle: CENTRE_HANDLE.id,
        selected: isSelected,
        data: {
          cable: link.cable,
          ports: [shortPortName(link.a.port), shortPortName(link.b.port)],
        },
        ariaLabel: label,
      };
      next.set(link.id, { link, selected: isSelected, label, edge });
      return edge;
    });
    cache = next;
    return edges;
  };
}

// Node ids are store ids, and store ids carry their kind as a prefix.
export const isDeviceId = (id: string): id is DeviceId => id.startsWith('dev_');
export const isAnnotationId = (id: string): id is AnnotationId => id.startsWith('ann_');

/** Width and height a node is drawn at, where the annotation fixes them. */
function fixedSize(annotation: AnnotationSpec): { width?: number; height?: number } {
  switch (annotation.kind) {
    case 'area':
    case 'shape':
      return annotation.size;
    case 'note':
    case 'text':
      return annotation.width === undefined ? {} : { width: annotation.width };
  }
}

function ariaLabel(annotation: AnnotationSpec): string {
  const text = annotationText(annotation);
  return text ? `${annotationLabel(annotation)}: ${text}` : annotationLabel(annotation);
}

type AnnotationEntry = {
  annotation: AnnotationSpec;
  selected: boolean;
  editing: boolean;
  node: AnnotationFlowNode;
};

/**
 * Annotations as React Flow nodes in draw order, positioned by their top-left corner, plus a note
 * or text being written. Area boxes sit below links (negative z), the rest above links and, coming
 * before devices in the node list, under devices.
 */
export function createAnnotationMapper() {
  let cache = new Map<string, AnnotationEntry>();
  return (
    annotations: Topology['annotations'],
    selected: ReadonlySet<AnnotationId>,
    editing: AnnotationId | undefined,
    draft: AnnotationSpec | undefined,
  ): AnnotationFlowNode[] => {
    const next = new Map<string, AnnotationEntry>();
    const node = (id: string, annotation: AnnotationSpec, isNew = false): AnnotationFlowNode => {
      const entry = {
        annotation,
        selected: selected.has(id as AnnotationId),
        editing: isNew || editing === id,
      };
      const hit = cache.get(id);
      if (
        hit &&
        hit.annotation === annotation &&
        hit.selected === entry.selected &&
        hit.editing === entry.editing
      ) {
        next.set(id, hit);
        return hit.node;
      }
      const size = fixedSize(annotation);
      const made = {
        id,
        type: annotation.kind,
        position: annotation.position,
        origin: [0, 0],
        ...size,
        initialWidth: size.width ?? INITIAL_TEXT_WIDTH,
        initialHeight: size.height ?? INITIAL_HEIGHT[annotation.kind],
        zIndex: LAYER_Z[ANNOTATION_KINDS[annotation.kind].layer],
        data: { annotation, editing: entry.editing },
        selected: entry.selected,
        draggable: !entry.editing,
        ariaLabel: ariaLabel(annotation),
      } as AnnotationFlowNode;
      next.set(id, { ...entry, node: made });
      return made;
    };
    const nodes = drawOrder(Object.values(annotations)).map((a) => node(a.id, a));
    if (draft) nodes.push(node(NEW_ANNOTATION_ID, draft, true));
    cache = next;
    return nodes;
  };
}

export type Moves = { devices: Move[]; annotations: AnnotationMove[] };

/** Node moves as store moves, split by what each node shows. */
export function movesFrom(changes: readonly NodeChange<CanvasNode>[]): Moves {
  const moves: Moves = { devices: [], annotations: [] };
  for (const change of changes) {
    if (change.type !== 'position' || !change.position) continue;
    if (isDeviceId(change.id)) moves.devices.push({ device: change.id, position: change.position });
    else if (isAnnotationId(change.id)) {
      moves.annotations.push({ annotation: change.id, position: change.position });
    }
  }
  return moves;
}

export type Resize = { annotation: AnnotationId; width?: number; height?: number };

/** What resize handles changed. Measuring a node also reports dimensions, without setAttributes. */
export function resizesFrom(changes: readonly NodeChange<CanvasNode>[]): Resize[] {
  return changes.flatMap((change) => {
    if (change.type !== 'dimensions' || !change.setAttributes || !change.dimensions) return [];
    if (!isAnnotationId(change.id)) return [];
    const { width, height } = change.dimensions;
    const which = change.setAttributes;
    return [
      {
        annotation: change.id,
        ...(which !== 'height' && { width }),
        ...(which !== 'width' && { height }),
      },
    ];
  });
}

/** The selection after React Flow's select changes, or undefined when they change nothing. */
export function applySelectChanges<Id extends string>(
  current: readonly Id[],
  changes: readonly (NodeChange | EdgeChange)[],
  belongs: (id: string) => boolean = () => true,
): Id[] | undefined {
  const ids = new Set(current);
  for (const change of changes) {
    if (change.type !== 'select' || !belongs(change.id)) continue;
    if (change.selected) ids.add(change.id as Id);
    else ids.delete(change.id as Id);
  }
  const unchanged = ids.size === current.length && current.every((id) => ids.has(id));
  return unchanged ? undefined : [...ids];
}
