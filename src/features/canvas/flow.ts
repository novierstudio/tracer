import { Position, type Edge, type EdgeChange, type Node, type NodeChange } from '@xyflow/react';
import { findDeviceModel, type DeviceIconName } from '@/devices/catalog';
import type { Cable, Device, DeviceId, DeviceKind, Link, LinkId, Move, Topology } from '@/model';
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
const CENTRE = { x: TILE / 2, y: TILE / 2, width: 0, height: 0, position: Position.Top };
const HANDLES = [
  { ...CENTRE, type: 'source' as const },
  { ...CENTRE, type: 'target' as const },
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

/** Node moves as store moves. Node ids are device ids, since the store made every node. */
export function movesFrom(changes: readonly NodeChange<DeviceFlowNode>[]): Move[] {
  return changes.flatMap((change) =>
    change.type === 'position' && change.position
      ? [{ device: change.id as DeviceId, position: change.position }]
      : [],
  );
}

/** The selection after React Flow's select changes, or undefined when they change nothing. */
export function applySelectChanges<Id extends string>(
  current: readonly Id[],
  changes: readonly (NodeChange | EdgeChange)[],
): Id[] | undefined {
  const ids = new Set(current);
  for (const change of changes) {
    if (change.type !== 'select') continue;
    if (change.selected) ids.add(change.id as Id);
    else ids.delete(change.id as Id);
  }
  const unchanged = ids.size === current.length && current.every((id) => ids.has(id));
  return unchanged ? undefined : [...ids];
}
