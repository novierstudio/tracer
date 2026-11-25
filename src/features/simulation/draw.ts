import type { FrameEvent } from '@/engine/events';
import { footprint, layoutCable, TILE, type Vec } from '@/features/canvas/geometry';
import type { DeviceId } from '@/model';
import { PROTOCOL_IDS, PROTOCOLS, type ProtocolId } from './protocols';
import type { Chip, ChipPlace } from './traffic';

export type Palette = {
  protocols: Record<ProtocolId, { fill: string; text: string }>;
  outline: string;
  accent: string;
  error: string;
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

export type Drawn = { chip: Chip; at: Vec };

const CHIP_HEIGHT = 18;
const CHIP_FONT = 10;
const CHIP_PADDING = 7;

/** Chips grow and shrink with the zoom, but stay big enough to read their label. */
const chipScale = (zoom: number) => Math.min(1.3, Math.max(0.9, zoom));

// Label widths by font, measured once rather than for every chip on every frame, and again
// once the web font has loaded.
const labelWidths = new Map<string, number>();
void document.fonts?.ready.then(() => labelWidths.clear());

function chipBox(ctx: CanvasRenderingContext2D, protocol: ProtocolId, scale: number) {
  const height = CHIP_HEIGHT * scale;
  const key = `${protocol} ${ctx.font}`;
  let label = labelWidths.get(key);
  if (label === undefined) {
    label = ctx.measureText(PROTOCOLS[protocol].label).width;
    labelWidths.set(key, label);
  }
  return { width: Math.max(height * 1.6, label + 2 * CHIP_PADDING * scale), height };
}

function setChipFont(ctx: CanvasRenderingContext2D, scale: number) {
  ctx.font = `650 ${CHIP_FONT * scale}px "Inter Variable", system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
}

/**
 * Paints the chips in screen space: a fading trail and a soft halo behind each moving chip, a
 * pill in its protocol's colour with the protocol's name on it, and a red cross where a frame
 * was lost. Returns where each chip went, in flow coordinates.
 */
export function drawChips(scene: Scene, places: readonly ChipPlace[]): Drawn[] {
  const { ctx, transform, palette, hidden } = scene;
  const [tx, ty, zoom] = transform;
  const scale = chipScale(zoom);
  const toScreen = (p: Vec): Vec => ({ x: p.x * zoom + tx, y: p.y * zoom + ty });
  const cache = new Map<string, [Vec, Vec]>();
  const drawn: Drawn[] = [];
  setChipFont(ctx, scale);

  for (const { chip, along, moving } of places) {
    if (hidden.includes(chip.protocol)) continue;
    const line = ends(scene, chip.event, cache);
    if (!line) continue;
    const lost = chip.event.outcome === 'link-down';
    const colours = palette.protocols[chip.protocol];
    const { width, height } = chipBox(ctx, chip.protocol, scale);
    // The chip's edge, not its centre, meets each light, so it never covers a device.
    const [a, b] = inset(toScreen(line[0]), toScreen(line[1]), width, height);
    const p = lerp(a, b, lost ? 0 : along);
    drawn.push({ chip, at: { x: (p.x - tx) / zoom, y: (p.y - ty) / zoom } });

    if (lost) {
      const fade = Math.max(0, 1 - (scene.wallNow - chip.start) / chip.duration);
      ctx.globalAlpha = chip.motion === 'travel' ? fade : 1;
      drawCross(ctx, p, 6 * scale, palette.error, palette.outline);
      ctx.globalAlpha = 1;
      continue;
    }

    if (moving) {
      const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const sign = chip.motion === 'return' ? -1 : 1;
      const behind = chip.motion === 'return' ? (1 - along) * length : along * length;
      const trail = Math.min(48 * scale, behind);
      const tail = {
        x: p.x - (sign * (b.x - a.x) * trail) / length,
        y: p.y - (sign * (b.y - a.y) * trail) / length,
      };
      const gradient = ctx.createLinearGradient(tail.x, tail.y, p.x, p.y);
      gradient.addColorStop(0, transparent(colours.fill));
      gradient.addColorStop(1, colours.fill);
      ctx.strokeStyle = gradient;
      ctx.globalAlpha = 0.5;
      ctx.lineWidth = height * 0.45;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(tail.x, tail.y);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      ctx.globalAlpha = 0.22;
      roundedRect(ctx, p.x, p.y, width + 8 * scale, height + 8 * scale);
      ctx.fillStyle = colours.fill;
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    roundedRect(ctx, p.x, p.y, width, height);
    ctx.fillStyle = colours.fill;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = palette.outline;
    ctx.stroke();
    ctx.fillStyle = colours.text;
    ctx.fillText(PROTOCOLS[chip.protocol].label, p.x, p.y + 0.5 * scale);
  }
  return drawn;
}

/** Pulls both ends of a screen-space segment in by half a chip's extent along it. */
function inset(a: Vec, b: Vec, width: number, height: number): [Vec, Vec] {
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  if (length < 1) return [a, b];
  const ux = (b.x - a.x) / length;
  const uy = (b.y - a.y) / length;
  const reach = Math.min(length / 2, (Math.abs(ux) * width + Math.abs(uy) * height) / 2 + 2);
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
  ctx.stroke();
}

/** A ring that breathes around the selected event's packet. */
export function drawPulse(scene: Scene, { chip, at }: Drawn) {
  const { ctx, transform, palette, wallNow } = scene;
  const [tx, ty, zoom] = transform;
  const scale = chipScale(zoom);
  setChipFont(ctx, scale);
  const { width, height } = chipBox(ctx, chip.protocol, scale);
  const phase = (wallNow % 1400) / 1400;
  const p = { x: at.x * zoom + tx, y: at.y * zoom + ty };
  ctx.lineWidth = 2;
  ctx.strokeStyle = palette.accent;
  roundedRect(ctx, p.x, p.y, width + 8, height + 8);
  ctx.stroke();
  ctx.globalAlpha = 0.6 * (1 - phase);
  roundedRect(ctx, p.x, p.y, width + 8 + 20 * phase, height + 8 + 20 * phase);
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
