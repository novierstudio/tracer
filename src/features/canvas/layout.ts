import type { ElkNode } from 'elkjs/lib/elk-api';
import type { Device, DeviceKind, Move, Point, Topology } from '@/model';
import { LABEL_GAP, snap, TILE } from './geometry';

export type LayoutEngine = (graph: ElkNode) => Promise<ElkNode>;

// Links point down the network: routers on top, then switches, then the hosts.
const TIER: Record<DeviceKind, number> = { router: 0, switch: 1, pc: 2, server: 2 };

// Room for the hostname and address under each tile, so labels never collide.
function box(device: Device) {
  const label = Math.max(device.config.hostname.length * 7 + 10, 15 * 6.2 + 6);
  return { width: Math.max(TILE, label), height: TILE + LABEL_GAP + 32 };
}

const OPTIONS = {
  'elk.algorithm': 'layered',
  'elk.direction': 'DOWN',
  'elk.edgeRouting': 'POLYLINE',
  'elk.spacing.nodeNode': '40',
  'elk.layered.spacing.nodeNodeBetweenLayers': '72',
  'elk.spacing.componentComponent': '64',
  'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
};

function centre(points: readonly Point[]): Point {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
}

let elk: Promise<LayoutEngine> | undefined;

/** elkjs is large, so it loads the first time someone lays out a lab. */
function loadElk(): Promise<LayoutEngine> {
  elk ??= import('elkjs/lib/elk.bundled.js').then(({ default: ELK }) => {
    const engine = new ELK();
    return (graph) => engine.layout(graph);
  });
  return elk;
}

/**
 * Where a layered, top-down layout puts every device, centred on where the devices are now and
 * snapped to the grid. Devices that would not move are left out.
 */
export async function layoutTopology(topology: Topology, engine?: LayoutEngine): Promise<Move[]> {
  const devices = Object.values(topology.devices);
  if (devices.length < 2) return [];
  const sizes = new Map(devices.map((device) => [device.id, box(device)]));
  const graph: ElkNode = {
    id: 'lab',
    layoutOptions: OPTIONS,
    children: devices.map((device) => ({ id: device.id, ...sizes.get(device.id) })),
    edges: Object.values(topology.links).map((link) => {
      const [from, to] = [link.a.device, link.b.device];
      const down = TIER[topology.devices[from]!.kind] <= TIER[topology.devices[to]!.kind];
      return { id: link.id, sources: [down ? from : to], targets: [down ? to : from] };
    }),
  };

  const laid = await (engine ?? (await loadElk()))(graph);
  const placed = new Map(
    (laid.children ?? []).map((node) => {
      const { width } = sizes.get(node.id as Device['id'])!;
      // ELK places boxes by their top-left corner; the tile centre is half a tile below the top.
      return [node.id, { x: (node.x ?? 0) + width / 2, y: (node.y ?? 0) + TILE / 2 }];
    }),
  );

  const from = centre(devices.map((device) => device.position));
  const to = centre([...placed.values()]);
  return devices.flatMap((device) => {
    const point = placed.get(device.id);
    if (!point) return [];
    const position = { x: snap(point.x - to.x + from.x), y: snap(point.y - to.y + from.y) };
    const same = position.x === device.position.x && position.y === device.position.y;
    return same ? [] : [{ device: device.id, position }];
  });
}
