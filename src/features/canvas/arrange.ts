import type { DeviceId, Move, Point } from '@/model';

export const ALIGN_EDGES = ['left', 'centre', 'right', 'top', 'middle', 'bottom'] as const;
export type AlignEdge = (typeof ALIGN_EDGES)[number];
export type Axis = 'horizontal' | 'vertical';

type Placed = { device: DeviceId; position: Point };

// Every tile is the same size and a device's position is its tile centre, so lining up tile edges
// is lining up centres: left edges meet where the leftmost centre is.
const ALIGN: Record<AlignEdge, { axis: 'x' | 'y'; pick: (values: number[]) => number }> = {
  left: { axis: 'x', pick: (v) => Math.min(...v) },
  centre: { axis: 'x', pick: (v) => (Math.min(...v) + Math.max(...v)) / 2 },
  right: { axis: 'x', pick: (v) => Math.max(...v) },
  top: { axis: 'y', pick: (v) => Math.min(...v) },
  middle: { axis: 'y', pick: (v) => (Math.min(...v) + Math.max(...v)) / 2 },
  bottom: { axis: 'y', pick: (v) => Math.max(...v) },
};

const changed = (moves: Move[], devices: readonly Placed[]) =>
  moves.filter(({ position }, i) => {
    const before = devices[i]!.position;
    return position.x !== before.x || position.y !== before.y;
  });

/** Moves that line the devices up on one edge or centre line. Devices already there stay out. */
export function alignMoves(devices: readonly Placed[], edge: AlignEdge): Move[] {
  if (devices.length < 2) return [];
  const { axis, pick } = ALIGN[edge];
  const target = pick(devices.map((d) => d.position[axis]));
  const moves = devices.map(({ device, position }) => ({
    device,
    position: { ...position, [axis]: target },
  }));
  return changed(moves, devices);
}

/** Moves that space the devices evenly between the two outermost, which stay put. */
export function distributeMoves(devices: readonly Placed[], direction: Axis): Move[] {
  if (devices.length < 3) return [];
  const axis = direction === 'horizontal' ? 'x' : 'y';
  const order = devices
    .map((_, i) => i)
    .sort((a, b) => {
      const delta = devices[a]!.position[axis] - devices[b]!.position[axis];
      return delta !== 0 ? delta : a - b;
    });
  const first = devices[order[0]!]!.position[axis];
  const last = devices[order.at(-1)!]!.position[axis];
  const step = (last - first) / (devices.length - 1);
  const moves = devices.map(({ device, position }) => ({ device, position }));
  order.forEach((index, rank) => {
    const { device, position } = devices[index]!;
    moves[index] = { device, position: { ...position, [axis]: first + step * rank } };
  });
  return changed(moves, devices);
}
