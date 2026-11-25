import { Position, type Edge, type EdgeChange, type Node, type NodeChange } from '@xyflow/react';
import { findDeviceModel, type DeviceIconName } from '@/devices/catalog';
import type {
  Annotation,
  AnnotationId,
  AnnotationMove,
  Cable,
  Device,
  DeviceId,
  DeviceKind,
  Link,
  LinkId,
  Move,
  Point,
  Topology,
} from '@/model';
import { CABLE_LABELS, shortPortName } from './cables';
import { TILE, type Size } from './geometry';

export type DeviceNodeData = {
  hostname: string;
  icon: DeviceIconName;
  address: string | undefined;
  powered: boolean;
  freePorts: number;
  totalPorts: number;
};
export type DeviceFlowNode = Node<DeviceNodeData, 'device'>;

type NoteNodeData = { text: string; editing: boolean };
export type NoteFlowNode = Node<NoteNodeData, 'note'>;

export type CanvasNode = DeviceFlowNode | NoteFlowNode;

/** A note card's width, and its height with up to three lines. */
const NOTE_SIZE = { width: 192, height: 76 };

/** The node for a note being written that is not in the lab yet. */
const NEW_NOTE_ID = 'note-new';

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
    powered: device.powered,
    freePorts: device.ports.length - used,
    totalPorts: device.ports.length,
  };
}

/** The hostname block under a tile. Estimated from text length so links can avoid it unmeasured. */
export function hostnameLabelSize({ hostname, address }: DeviceNodeData): Size {
  const width = Math.max(hostname.length * 7 + 10, address ? address.length * 6.2 + 6 : 0);
  return { width, height: address ? 32 : 18 };
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
export const isNoteId = (id: string): id is AnnotationId => id.startsWith('ann_');

/** Notes as React Flow nodes, positioned by their top-left corner, plus a note being written. */
export function createNoteMapper() {
  let cache = new Map<string, NoteFlowNode>();
  return (
    annotations: Topology['annotations'],
    selected: ReadonlySet<AnnotationId>,
    editing: AnnotationId | undefined,
    draft: Point | undefined,
  ): NoteFlowNode[] => {
    const next = new Map<string, NoteFlowNode>();
    const node = (id: string, note: Pick<Annotation, 'position' | 'text'>, isNew = false) => {
      const isSelected = selected.has(id as AnnotationId);
      const isEditing = isNew || editing === id;
      const hit = cache.get(id);
      const reused =
        hit &&
        hit.position === note.position &&
        hit.data.text === note.text &&
        hit.data.editing === isEditing &&
        hit.selected === isSelected;
      const made: NoteFlowNode = reused
        ? hit
        : {
            id,
            type: 'note',
            position: note.position,
            origin: [0, 0],
            // A size up front shows the node before React Flow measures it, so a new note's
            // field is on screen, and can take focus, the moment N is pressed.
            initialWidth: NOTE_SIZE.width,
            initialHeight: NOTE_SIZE.height,
            data: { text: note.text, editing: isEditing },
            selected: isSelected,
            draggable: !isEditing,
            ariaLabel: `Note: ${note.text}`,
          };
      next.set(id, made);
      return made;
    };
    const nodes = Object.values(annotations).map((note) => node(note.id, note));
    if (draft) nodes.push(node(NEW_NOTE_ID, { position: draft, text: '' }, true));
    cache = next;
    return nodes;
  };
}

export type Moves = { devices: Move[]; notes: AnnotationMove[] };

/** Node moves as store moves, split by what each node shows. */
export function movesFrom(changes: readonly NodeChange<CanvasNode>[]): Moves {
  const moves: Moves = { devices: [], notes: [] };
  for (const change of changes) {
    if (change.type !== 'position' || !change.position) continue;
    if (isDeviceId(change.id)) moves.devices.push({ device: change.id, position: change.position });
    else if (isNoteId(change.id)) {
      moves.notes.push({ annotation: change.id, position: change.position });
    }
  }
  return moves;
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
