import type { EventId, FrameEvent } from '@/engine/events';
import { footprint, layoutCable, TILE, type Vec } from '@/features/canvas/geometry';
import type { DeviceId } from '@/model';
import { PROTOCOL_IDS, PROTOCOLS, type ProtocolId } from './protocols';
import type { Chip, ChipPlace, RingPlace } from './traffic';

export type Palette = {
  protocols: Record<ProtocolId, { fill: string; text: string }>;
  outline: string;
  accent: string;
  error: string;
  /** The text colour, for the VLAN badge. */
  ink: string;
};

/** Reads the theme's tokens where the overlay sits, since `.light` and `.dark` re-scope them. */
export function readPalette(element: Element): Palette {
  const style = getComputedStyle(element);
  const token = (name: string) => style.getPropertyValue(name).trim();
  const protocols = Object.fromEntries(
    PROTOCOL_IDS.map((id) => {
      const fill = token(PROTOCOLS[id].token) || '#888';
      return [id, { fill, text: readableOn(fill) }];
    }),
  ) as Palette['protocols'];
  return {
    protocols,
    outline: token('--surface-1') || '#fff',
    accent: token('--accent') || '#5b5bd6',
    error: token('--err') || '#c81e1e',
    ink: token('--text-1') || '#18181b',
  };
}

const DARK_TEXT = '#0c0c0e';
const DARK_LUMINANCE = 0.0037;

/** Near-black or white text, whichever has the higher WCAG contrast on a hex colour. */
function readableOn(hex: string): string {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!match) return '#ffffff';
  const value = parseInt(match[1]!, 16);
  const channel = (shift: number) => {
    const c = ((value >> shift) & 0xff) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0);
  const onWhite = 1.05 / (luminance + 0.05);
  const onDark = (luminance + 0.05) / (DARK_LUMINANCE + 0.05);
  return onDark > onWhite ? DARK_TEXT : '#ffffff';
}

/** A device as the overlay needs it: its tile centre and the hostname block under it. */
export type DevicePlace = { centre: Vec; label: { width: number; height: number } };

export type Scene = {
  ctx: CanvasRenderingContext2D;
  /** React Flow's viewport: flow point p shows at p * zoom + (x, y). */
  transform: readonly [number, number, number];
  device(id: DeviceId): DevicePlace | undefined;
  palette: Palette;
  hidden: readonly ProtocolId[];
  wallNow: number;
  /** The event selected in Simulation mode. The other chips dim. */
  selected?: EventId;
  reducedMotion: boolean;
};

const PORT_LABEL = { width: 0, height: 0 };

/** Where a frame's chip starts and stops: at the link lights, clear of both devices. */
function ends(scene: Scene, event: FrameEvent, cache: Map<string, [Vec, Vec]>) {
  const key = `${event.from.device} ${event.to.device}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const from = scene.device(event.from.device);
  const to = scene.device(event.to.device);
  if (!from || !to) return undefined;
  const layout = layoutCable(
    { centre: from.centre, footprint: footprint(from.label), portLabel: PORT_LABEL },
    { centre: to.centre, footprint: footprint(to.label), portLabel: PORT_LABEL },
    false,
  );
  const result = layout.lights ?? clearOfTiles(from.centre, to.centre);
  cache.set(key, result);
  return result;
}

function clearOfTiles(a: Vec, b: Vec): [Vec, Vec] {
  const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const reach = Math.min(TILE / 2 + 6, length / 2);
  const ux = (b.x - a.x) / length;
  const uy = (b.y - a.y) / length;
  return [
    { x: a.x + ux * reach, y: a.y + uy * reach },
    { x: b.x - ux * reach, y: b.y - uy * reach },
  ];
}

const lerp = (a: Vec, b: Vec, t: number): Vec => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
});

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  ctx.beginPath();
  ctx.roundRect(x - w / 2, y - h / 2, w, h, h / 2);
}

/** Where a chip went, in canvas pixels: its centre and the box a pointer can hit. */
export type Drawn = { chip: Chip; x: number; y: number; width: number; height: number };

const CHIP_HEIGHT = 18;
const CHIP_FONT = 10;
const CHIP_PADDING = 7;
const ARROW_LENGTH = 6;
const ARROW_HALF_WIDTH = 4.5;
const BADGE_HEIGHT = 11;
const BADGE_FONT = 8;
/**
 * How much of the surface colour washes over the other chips while an event is selected. A wash
 * rather than transparency, so a dimmed chip still hides the port label under it.
 */
const WASH = 0.6;

/** Chips grow and shrink with the zoom, but stay big enough to read their label. */
const chipScale = (zoom: number) => Math.min(1.3, Math.max(0.9, zoom));

// Text widths by font, measured once rather than for every chip on every frame, and again
// once the web font has loaded.
const textWidths = new Map<string, number>();
void document.fonts?.ready.then(() => textWidths.clear());

function textWidth(ctx: CanvasRenderingContext2D, text: string) {
  const key = `${text} ${ctx.font}`;
  let width = textWidths.get(key);
  if (width === undefined) {
    width = ctx.measureText(text).width;
    textWidths.set(key, width);
  }
  return width;
}

function chipBox(ctx: CanvasRenderingContext2D, protocol: ProtocolId, scale: number) {
  const height = CHIP_HEIGHT * scale;
  const label = textWidth(ctx, PROTOCOLS[protocol].label);
  return { width: Math.max(height * 1.6, label + 2 * CHIP_PADDING * scale), height };
}

const font = (weight: number, size: number) =>
  `${weight} ${size}px "Inter Variable", system-ui, sans-serif`;

function setChipFont(ctx: CanvasRenderingContext2D, scale: number) {
  ctx.font = font(650, CHIP_FONT * scale);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
}

const vlanOf = ({ frame }: FrameEvent) => (frame.kind === 'ethernet' ? frame.tag?.vlan : undefined);

/**
 * Paints the chips in screen space: a fading trail and a soft halo behind each moving chip, a
 * pill in its protocol's colour with the protocol's name on it and an arrowhead the way it is
 * going, and a red cross where a frame was dropped. While an event is selected the other chips
 * dim, and the selected one paints on top. Returns where each chip went, top-most last.
 */
export function drawChips(scene: Scene, places: readonly ChipPlace[]): Drawn[] {
  const { ctx, transform, hidden, selected } = scene;
  const [tx, ty, zoom] = transform;
  const scale = chipScale(zoom);
  const toScreen = (p: Vec): Vec => ({ x: p.x * zoom + tx, y: p.y * zoom + ty });
  const cache = new Map<string, [Vec, Vec]>();
  const drawn: Drawn[] = [];
  const base = ctx.getTransform();
  setChipFont(ctx, scale);

  const paint = (place: ChipPlace, dimmed: boolean) => {
    const line = ends(scene, place.chip.event, cache);
    if (!line) return;
    const [from, to] = [toScreen(line[0]), toScreen(line[1])];
    drawn.push(drawChip(scene, place, from, to, scale, dimmed, base));
  };
  let held: ChipPlace | undefined;
  for (const place of places) {
    if (hidden.includes(place.chip.protocol)) continue;
    if (place.chip.event.id === selected) held = place;
    else paint(place, selected !== undefined);
  }
  if (held) paint(held, false);
  ctx.globalAlpha = 1;
  return drawn;
}

function drawChip(
  scene: Scene,
  { chip, along, moving, dropped, scale: size, alpha }: ChipPlace,
  from: Vec,
  to: Vec,
  scale: number,
  dimmed: boolean,
  base: DOMMatrix,
): Drawn {
  const { ctx, palette } = scene;
  const colours = palette.protocols[chip.protocol];
  const { width, height } = chipBox(ctx, chip.protocol, scale);
  // The chip's edge and arrowhead, not its centre, meet each light, so it never covers a device.
  const [a, b] = inset(from, to, width, height, ARROW_LENGTH * scale);
  const p = lerp(a, b, along);

  if (dropped) {
    const r = 6 * scale * size;
    ctx.globalAlpha = alpha;
    drawCross(ctx, p, r, palette.error, palette.outline);
    if (dimmed) {
      ctx.globalAlpha = alpha * WASH;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r + 3, 0, Math.PI * 2);
      ctx.fillStyle = palette.outline;
      ctx.fill();
    }
    return { chip, x: p.x, y: p.y, width: 2 * (r + 3), height: 2 * (r + 3) };
  }

  const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const ux = (b.x - a.x) / length;
  const uy = (b.y - a.y) / length;
  if (moving) {
    const sign = chip.motion === 'return' ? -1 : 1;
    const behind = chip.motion === 'return' ? (1 - along) * length : along * length;
    const trail = Math.min(48 * scale, behind);
    const tail = { x: p.x - sign * ux * trail, y: p.y - sign * uy * trail };
    const gradient = ctx.createLinearGradient(tail.x, tail.y, p.x, p.y);
    gradient.addColorStop(0, transparent(colours.fill));
    gradient.addColorStop(1, colours.fill);
    ctx.strokeStyle = gradient;
    const trace = dimmed ? 1 - WASH : 1;
    ctx.globalAlpha = 0.5 * alpha * trace;
    ctx.lineWidth = height * 0.45 * size;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(tail.x, tail.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    ctx.globalAlpha = 0.22 * alpha * trace;
    roundedRect(ctx, p.x, p.y, (width + 8 * scale) * size, (height + 8 * scale) * size);
    ctx.fillStyle = colours.fill;
    ctx.fill();
  }

  // The body, drawn about its centre so that it can grow in and shrink out.
  ctx.globalAlpha = alpha;
  ctx.translate(p.x, p.y);
  if (size !== 1) ctx.scale(size, size);
  ctx.fillStyle = colours.fill;
  ctx.strokeStyle = palette.outline;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  // The arrowhead goes first, so the pill covers its base and only its point shows ahead.
  const edge = Math.min(
    width / 2 / Math.max(Math.abs(ux), 1e-6),
    height / 2 / Math.max(Math.abs(uy), 1e-6),
  );
  const tip = edge + ARROW_LENGTH * scale;
  const back = edge - 3 * scale;
  const half = ARROW_HALF_WIDTH * scale;
  const arrow = () => {
    ctx.beginPath();
    ctx.moveTo(ux * tip, uy * tip);
    ctx.lineTo(ux * back - uy * half, uy * back + ux * half);
    ctx.lineTo(ux * back + uy * half, uy * back - ux * half);
    ctx.closePath();
  };
  arrow();
  ctx.stroke();
  ctx.fill();
  roundedRect(ctx, 0, 0, width, height);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = colours.text;
  ctx.fillText(PROTOCOLS[chip.protocol].label, 0, 0.5 * scale);
  const wash = dimmed ? alpha * WASH : 0;
  if (wash > 0) {
    ctx.globalAlpha = wash;
    ctx.fillStyle = palette.outline;
    arrow();
    ctx.fill();
    roundedRect(ctx, 0, 0, width + 2, height + 2);
    ctx.fill();
  }
  const vlan = vlanOf(chip.event);
  if (vlan !== undefined) {
    ctx.globalAlpha = alpha;
    drawBadge(ctx, String(vlan), { right: width / 2, top: -height / 2 }, scale, palette, wash);
  }
  ctx.setTransform(base);
  return { chip, x: p.x, y: p.y, width: width * size, height: height * size };
}

/** A tiny VLAN number on the chip's top right corner, for an 802.1Q-tagged frame. */
function drawBadge(
  ctx: CanvasRenderingContext2D,
  text: string,
  { right, top }: { right: number; top: number },
  scale: number,
  palette: Palette,
  wash: number,
) {
  ctx.font = font(700, BADGE_FONT * scale);
  const height = BADGE_HEIGHT * scale;
  const width = Math.max(height, textWidth(ctx, text) + 6 * scale);
  const x = right - width / 2 + 3 * scale;
  const y = top + scale;
  roundedRect(ctx, x, y, width, height);
  ctx.fillStyle = palette.ink;
  ctx.lineWidth = 1.5;
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = palette.outline;
  ctx.fillText(text, x, y + 0.5 * scale);
  if (wash > 0) {
    ctx.globalAlpha = wash;
    roundedRect(ctx, x, y, width + 1.5, height + 1.5);
    ctx.fill();
  }
  ctx.font = font(650, CHIP_FONT * scale);
}

/** Pulls both ends of a screen-space segment in by half a chip's extent along it, and `extra`. */
function inset(a: Vec, b: Vec, width: number, height: number, extra: number): [Vec, Vec] {
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  if (length < 1) return [a, b];
  const ux = (b.x - a.x) / length;
  const uy = (b.y - a.y) / length;
  const reach = Math.min(
    length / 2,
    (Math.abs(ux) * width + Math.abs(uy) * height) / 2 + 2 + extra,
  );
  return [
    { x: a.x + ux * reach, y: a.y + uy * reach },
    { x: b.x - ux * reach, y: b.y - uy * reach },
  ];
}

function transparent(colour: string) {
  return /^#[0-9a-f]{6}$/i.test(colour) ? `${colour}00` : 'transparent';
}

function drawCross(
  ctx: CanvasRenderingContext2D,
  p: Vec,
  r: number,
  colour: string,
  outline: string,
) {
  ctx.beginPath();
  ctx.arc(p.x, p.y, r + 3, 0, Math.PI * 2);
  ctx.fillStyle = colour;
  ctx.fill();
  ctx.strokeStyle = outline;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(p.x - r / 2, p.y - r / 2);
  ctx.lineTo(p.x + r / 2, p.y + r / 2);
  ctx.moveTo(p.x + r / 2, p.y - r / 2);
  ctx.lineTo(p.x - r / 2, p.y + r / 2);
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.stroke();
}

/** Rings spreading from devices that flood or broadcast a frame. Paint them under the chips. */
export function drawRings(scene: Scene, rings: readonly RingPlace[]) {
  const { ctx, transform, palette, hidden } = scene;
  const [tx, ty, zoom] = transform;
  ctx.lineWidth = 2;
  for (const { device, protocol, spread, alpha } of rings) {
    if (hidden.includes(protocol)) continue;
    const place = scene.device(device);
    if (!place) continue;
    // From just clear of the tile's corners, outwards.
    const radius = (TILE * 0.74 + spread * 30) * zoom;
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = palette.protocols[protocol].fill;
    ctx.beginPath();
    ctx.arc(place.centre.x * zoom + tx, place.centre.y * zoom + ty, radius, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

/** A ring around the selected event's packet, breathing unless motion is reduced. */
export function drawPulse(scene: Scene, { x, y, width, height }: Drawn) {
  const { ctx, palette, wallNow, reducedMotion } = scene;
  ctx.lineWidth = 2;
  ctx.strokeStyle = palette.accent;
  roundedRect(ctx, x, y, width + 8, height + 8);
  ctx.stroke();
  if (reducedMotion) return;
  const phase = (wallNow % 1400) / 1400;
  ctx.globalAlpha = 0.6 * (1 - phase);
  roundedRect(ctx, x, y, width + 8 + 20 * phase, height + 8 + 20 * phase);
  ctx.stroke();
  ctx.globalAlpha = 1;
}

/** A dashed ring around the device the Add simple PDU tool picked as the source. */
export function drawSourceRing(scene: Scene, centre: Vec) {
  const { ctx, transform, palette } = scene;
  const [tx, ty, zoom] = transform;
  const half = (TILE / 2 + 6) * zoom;
  ctx.setLineDash([5, 4]);
  ctx.lineWidth = 2;
  ctx.strokeStyle = palette.accent;
  ctx.beginPath();
  ctx.roundRect(
    centre.x * zoom + tx - half,
    centre.y * zoom + ty - half,
    half * 2,
    half * 2,
    14 * zoom,
  );
  ctx.stroke();
  ctx.setLineDash([]);
}

/** Where a frame's packet sits once it has arrived, for panning to an event. */
export function restingPoint(scene: Pick<Scene, 'device'>, event: FrameEvent): Vec | undefined {
  const line = ends(scene as Scene, event, new Map());
  return line && lerp(line[0], line[1], event.outcome === 'link-down' ? 0.15 : 1);
}
