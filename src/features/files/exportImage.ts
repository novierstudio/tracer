import { toBlob, toSvg } from 'html-to-image';

export type ImageFormat = 'png' | 'svg';
export type ImageBackground = 'theme' | 'transparent';

const PADDING = 32;
const SCALE = 2;
// Browsers refuse canvases much past this on a side, so big labs export at a lower scale.
const MAX_CANVAS_SIDE = 16384;
// Canvas state that should not show in a picture of the lab.
const TRANSIENT_CLASSES = ['is-cabling', 'is-connecting', 'is-zoomed-out'];

type Bounds = { left: number; top: number; right: number; bottom: number };

/** The flow-space box around every device, note and cable, from where they are drawn now. */
function contentBounds(viewport: HTMLElement): Bounds | undefined {
  const zoom = new DOMMatrixReadOnly(getComputedStyle(viewport).transform).a || 1;
  const origin = viewport.getBoundingClientRect();
  let bounds: Bounds | undefined;
  const parts = viewport.querySelectorAll(
    '.react-flow__node, .react-flow__node *, .react-flow__edge',
  );
  for (const part of parts) {
    const rect = part.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    const left = (rect.left - origin.left) / zoom;
    const top = (rect.top - origin.top) / zoom;
    const right = left + rect.width / zoom;
    const bottom = top + rect.height / zoom;
    bounds = bounds
      ? {
          left: Math.min(bounds.left, left),
          top: Math.min(bounds.top, top),
          right: Math.max(bounds.right, right),
          bottom: Math.max(bounds.bottom, bottom),
        }
      : { left, top, right, bottom };
  }
  return bounds;
}

/**
 * Draws the lab on the canvas as an image, fitted to its content at 2x, in the current theme.
 * It captures a copy of React Flow's viewport, so selection, hover and the current pan and zoom
 * stay out of the picture and the canvas does not flicker. Undefined when the canvas is empty.
 */
export async function captureCanvas(
  format: ImageFormat,
  background: ImageBackground,
): Promise<Blob | undefined> {
  const canvas = document.querySelector<HTMLElement>('.tracer-canvas');
  const flow = canvas?.querySelector<HTMLElement>('.react-flow');
  const viewport = flow?.querySelector<HTMLElement>('.react-flow__viewport');
  if (!canvas || !flow || !viewport) throw new Error('The canvas has not loaded yet.');
  const bounds = contentBounds(viewport);
  if (!bounds) return undefined;

  const width = Math.ceil(bounds.right - bounds.left + PADDING * 2);
  const height = Math.ceil(bounds.bottom - bounds.top + PADDING * 2);

  // The copy sits off screen inside the canvas, under a React Flow root without the transient
  // classes, so the canvas and React Flow styles and theme variables still apply to it.
  const host = document.createElement('div');
  host.className = [...flow.classList]
    .filter((name) => !TRANSIENT_CLASSES.includes(name))
    .join(' ');
  Object.assign(host.style, {
    position: 'absolute',
    left: '-100000px',
    top: '0',
    width: `${width}px`,
    height: `${height}px`,
    pointerEvents: 'none',
  });
  host.setAttribute('aria-hidden', 'true');
  const copy = viewport.cloneNode(true) as HTMLElement;
  copy.querySelectorAll('.selected').forEach((element) => element.classList.remove('selected'));
  host.append(copy);
  canvas.append(host);

  try {
    const options = {
      width,
      height,
      pixelRatio: Math.min(SCALE, MAX_CANVAS_SIDE / Math.max(width, height)),
      backgroundColor:
        background === 'theme' ? getComputedStyle(canvas).backgroundColor : undefined,
      style: {
        width: `${width}px`,
        height: `${height}px`,
        transform: `translate(${PADDING - bounds.left}px, ${PADDING - bounds.top}px) scale(1)`,
      },
    };
    if (format === 'png') return (await toBlob(copy, options)) ?? undefined;
    const svg = decodeURIComponent((await toSvg(copy, options)).replace(/^data:[^,]*,/, ''));
    return new Blob([svg], { type: 'image/svg+xml' });
  } finally {
    host.remove();
  }
}
