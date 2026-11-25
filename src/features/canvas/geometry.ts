/** Side of a device tile in flow units. A device's position is its tile centre. */
export const TILE = 48;
export const GRID = 16;
/** Space between the tile and the hostname label under it. */
export const LABEL_GAP = 6;

const HALF = TILE / 2;
const LIGHT_RADIUS = 3.5;
const LIGHT_OFFSET = 7;
const PORT_LABEL_GAP = 6;

export type Vec = { x: number; y: number };
export type Size = { width: number; height: number };
type Box = { left: number; top: number; right: number; bottom: number };

/** A device's tile and the label block under it, relative to the tile centre, inside out. */
export function footprint(label: Size): Box[] {
  const top = HALF + LABEL_GAP;
  return [
    { left: -HALF, top: -HALF, right: HALF, bottom: HALF },
    { left: -label.width / 2, top, right: label.width / 2, bottom: top + label.height },
  ];
}

/** Where a ray through the box starts and stops, as distances along the ray. */
function crossing(direction: Vec, box: Box): [number, number] {
  let enter = -Infinity;
  let leave = Infinity;
  const axes: [number, number, number][] = [
    [direction.x, box.left, box.right],
    [direction.y, box.top, box.bottom],
  ];
  for (const [d, low, high] of axes) {
    if (Math.abs(d) < 1e-9) {
      if (low > 0 || high < 0) return [Infinity, -Infinity];
      continue;
    }
    const [near, far] = [low / d, high / d].sort((p, q) => p - q) as [number, number];
    enter = Math.max(enter, near);
    leave = Math.min(leave, far);
  }
  return enter <= leave ? [enter, leave] : [Infinity, -Infinity];
}

/** How far a ray from the tile centre runs before it clears the device's footprint. */
function exitDistance(direction: Vec, boxes: readonly Box[]): number {
  let distance = 0;
  for (const box of boxes) {
    const [enter, leave] = crossing(direction, box);
    if (enter <= distance + LABEL_GAP + 1 && leave > distance) distance = leave;
  }
  return distance;
}

export type CableEnd = { centre: Vec; footprint: readonly Box[]; portLabel: Size };

export type CableLayout = {
  path: string;
  /** Link lights just outside each device, when the link is long enough to show them. */
  lights?: [Vec, Vec];
  /** Port label centres beyond each light, when there is room for both. */
  labels?: [Vec, Vec];
};

function zigzag(a: Vec, b: Vec, along: Vec, length: number): string {
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const normal = { x: -along.y, y: along.x };
  const point = (t: number, n: number) =>
    `${mid.x + along.x * t + normal.x * n},${mid.y + along.y * t + normal.y * n}`;
  if (length < 64) return `M${a.x},${a.y}L${b.x},${b.y}`;
  return `M${a.x},${a.y}L${point(-10, 0)}L${point(-3, 9)}L${point(3, -9)}L${point(10, 0)}L${b.x},${b.y}`;
}

/** A link drawn centre to centre, under the tiles, with its lights and port labels placed. */
export function layoutCable(a: CableEnd, b: CableEnd, serial: boolean): CableLayout {
  const dx = b.centre.x - a.centre.x;
  const dy = b.centre.y - a.centre.y;
  const length = Math.hypot(dx, dy);
  if (length < 1) return { path: '' };

  const along = { x: dx / length, y: dy / length };
  const back = { x: -along.x, y: -along.y };
  const path = serial
    ? zigzag(a.centre, b.centre, along, length)
    : `M${a.centre.x},${a.centre.y}L${b.centre.x},${b.centre.y}`;

  const lightA = exitDistance(along, a.footprint) + LIGHT_OFFSET;
  const lightB = exitDistance(back, b.footprint) + LIGHT_OFFSET;
  if (lightA + lightB + 4 * LIGHT_RADIUS > length) return { path };

  const at = (t: number): Vec => ({ x: a.centre.x + along.x * t, y: a.centre.y + along.y * t });
  const lights: [Vec, Vec] = [at(lightA), at(length - lightB)];

  // Half the label's extent along the link, so the label never overlaps its light.
  const reach = ({ width, height }: Size) =>
    (Math.abs(along.x) * width) / 2 + (Math.abs(along.y) * height) / 2;
  const labelA = lightA + LIGHT_RADIUS + PORT_LABEL_GAP + reach(a.portLabel);
  const labelB = lightB + LIGHT_RADIUS + PORT_LABEL_GAP + reach(b.portLabel);
  const room = labelA + reach(a.portLabel) + labelB + reach(b.portLabel) + 2 * PORT_LABEL_GAP;
  if (room > length) return { path, lights };

  return { path, lights, labels: [at(labelA), at(length - labelB)] };
}
