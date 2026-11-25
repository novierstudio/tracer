import './simulation.css';
import { Panel, useReactFlow, useStoreApi } from '@xyflow/react';
import { MailIcon } from 'lucide-react';
import { useEffect, useRef, type RefObject } from 'react';
import type { EventId, FrameEvent } from '@/engine/events';
import { hostnameLabelSize, type DeviceNodeData } from '@/features/canvas/flow';
import type { DeviceId } from '@/model';
import { editorStore } from '@/model/store';
import { Kbd } from '@/ui/kbd';
import { simulation, traffic } from './controller';
import {
  drawChips,
  drawPulse,
  drawRings,
  drawSourceRing,
  readPalette,
  restingPoint,
  type DevicePlace,
  type Drawn,
  type Scene,
} from './draw';
import { protocolOf } from './protocols';
import { simulationStore, useSimulation } from './store';
import type { ChipPlace } from './traffic';

declare global {
  interface Window {
    /** The chips on screen, for e2e tests. Set with the other dev handles. */
    tracerTraffic?: {
      chips(): {
        event: EventId;
        link: string;
        protocol: string;
        motion: string;
        drop: string | undefined;
        /** Where it is on the page, in client pixels. */
        x: number;
        y: number;
      }[];
    };
  }
}

/** Frames are sorted by id, so the selected one is a binary search away. */
function findFrame(frames: readonly FrameEvent[], id: EventId): FrameEvent | undefined {
  let low = 0;
  let high = frames.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const frame = frames[middle]!;
    if (frame.id === id) return frame;
    if (frame.id < id) low = middle + 1;
    else high = middle - 1;
  }
  return undefined;
}

type FlowStore = ReturnType<typeof useStoreApi>;

/** A device's tile centre, from the editor, and its hostname block, from React Flow's node. */
function devicePlace(flowStore: FlowStore, id: DeviceId): DevicePlace | undefined {
  const placed = editorStore.getState().topology.devices[id];
  if (!placed) return undefined;
  const data = flowStore.getState().nodeLookup.get(id)?.data as DeviceNodeData | undefined;
  return {
    centre: placed.position,
    label: data ? hostnameLabelSize(data) : { width: 0, height: 0 },
  };
}

const reducedMotion = () =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

function isTypingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
    return true;
  return !!target.closest('[role="menu"], [role="dialog"], [role="grid"], [role="radiogroup"]');
}

/** → steps, ← steps back and Space plays or pauses, in Simulation mode. */
function useSimulationKeys() {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (simulationStore.getState().mode !== 'simulation' || isTypingTarget(event.target)) return;
      // A selected device on the canvas moves with the arrow keys.
      if (event.target instanceof Element && event.target.closest('.react-flow__node')) return;
      const action =
        event.key === 'ArrowRight'
          ? simulation.step
          : event.key === 'ArrowLeft'
            ? simulation.stepBack
            : event.key === ' ' && !event.repeat && !(event.target instanceof HTMLButtonElement)
              ? simulation.togglePlay
              : undefined;
      if (!action) return;
      event.preventDefault();
      action();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}

function PduHint() {
  const pdu = useSimulation((state) => state.pdu);
  if (pdu.step === 'off') return null;
  const source =
    pdu.step === 'destination' ? editorStore.getState().topology.devices[pdu.source] : undefined;
  return (
    <Panel position="bottom-center" style={{ marginBottom: 64 }}>
      <div
        role="status"
        className="flex items-center gap-2.5 rounded-lg border border-line bg-surface-1 py-1.5 pr-1.5 pl-3 text-xs text-fg-2 shadow-pop"
      >
        <MailIcon className="size-3.5 text-accent-text" />
        <span>
          {source ? (
            <>
              <span className="font-medium text-fg-1">{source.config.hostname}</span> sends an echo
              request. Click the device it pings.
            </>
          ) : (
            'Add simple PDU: click the device that sends the ping.'
          )}
          {pdu.problem && <span className="ml-1.5 font-medium text-warn">{pdu.problem}</span>}
        </span>
        <span className="flex items-center gap-1 text-fg-3">
          <Kbd>Esc</Kbd> to cancel
        </span>
      </div>
    </Panel>
  );
}

/** Lets the Add simple PDU tool take clicks on devices while it is on. */
function usePduClicks(canvas: RefObject<HTMLCanvasElement | null>) {
  const step = useSimulation((state) => state.pdu.step);
  useEffect(() => {
    const root = canvas.current?.closest<HTMLElement>('.react-flow');
    if (step === 'off' || !root) return;
    root.dataset.pduTool = step;
    const deviceAt = (event: Event) =>
      event.target instanceof Element
        ? event.target.closest('.react-flow__node')?.getAttribute('data-id')
        : undefined;
    // Picking a device must not also select, drag or cable it.
    const swallow = (event: Event) => {
      if (deviceAt(event)) event.stopPropagation();
    };
    const pick = (event: MouseEvent) => {
      const id = deviceAt(event);
      if (!id) return;
      event.stopPropagation();
      simulation.pickPduDevice(id as DeviceId);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      simulation.cancelPdu();
    };
    root.addEventListener('pointerdown', swallow, true);
    root.addEventListener('mousedown', swallow, true);
    root.addEventListener('click', pick, true);
    window.addEventListener('keydown', escape, true);
    return () => {
      delete root.dataset.pduTool;
      root.removeEventListener('pointerdown', swallow, true);
      root.removeEventListener('mousedown', swallow, true);
      root.removeEventListener('click', pick, true);
      window.removeEventListener('keydown', escape, true);
    };
  }, [step, canvas]);
}

/**
 * Packets on the canvas: one 2D canvas over React Flow's edges and nodes, drawn in screen space
 * from the viewport transform every animation frame, so it follows pan and zoom for free.
 * Mount it inside <ReactFlow>.
 */
export function TrafficOverlay() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const flowStore = useStoreApi();
  const flow = useReactFlow();
  const focusRequest = useSimulation((state) => state.focusRequest);

  useSimulationKeys();
  usePduClicks(canvas);

  useEffect(() => {
    const element = canvas.current;
    const ctx = element?.getContext('2d');
    if (!element || !ctx) return;
    // React Flow's root carries the theme class the tokens re-scope on.
    const themed = element.closest<HTMLElement>('.react-flow') ?? element;
    const device = (id: DeviceId) => devicePlace(flowStore, id);

    let palette = readPalette(themed);
    const theme = new MutationObserver(() => (palette = readPalette(themed)));
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    theme.observe(themed, { attributes: true, attributeFilter: ['class'] });

    let dpr = 1;
    const resize = () => {
      dpr = window.devicePixelRatio || 1;
      element.width = Math.round(element.clientWidth * dpr);
      element.height = Math.round(element.clientHeight * dpr);
    };
    const sizes = new ResizeObserver(resize);
    sizes.observe(element);
    resize();

    let drawnLast: Drawn[] = [];
    if (import.meta.env.DEV || window.__TRACER_DEV__) {
      window.tracerTraffic = {
        chips: () => {
          const box = element.getBoundingClientRect();
          return drawnLast.map(({ chip, x, y }) => ({
            event: chip.event.id,
            link: chip.event.link,
            protocol: chip.protocol,
            motion: chip.motion,
            drop: chip.drop,
            x: box.left + x,
            y: box.top + y,
          }));
        },
      };
    }

    let painted = false;
    let shown = -1;
    let frame = requestAnimationFrame(function paint() {
      frame = requestAnimationFrame(paint);
      const state = simulationStore.getState();
      const wallNow = performance.now();
      const still = reducedMotion();
      const { chips: places, rings } = state.showTraffic
        ? traffic.frame(wallNow, { reducedMotion: still })
        : { chips: [], rings: [] };
      const selected =
        state.mode === 'simulation' && state.selected !== undefined
          ? findFrame(state.frames, state.selected)
          : undefined;
      const focus =
        selected && !state.hidden.includes(protocolOf(selected.frame)) ? selected : undefined;
      const source = state.pdu.step === 'destination' ? device(state.pdu.source) : undefined;
      if (places.length === 0 && rings.length === 0 && !focus && !source) {
        if (painted) ctx.clearRect(0, 0, element.width, element.height);
        painted = false;
        drawnLast = [];
        if (shown !== 0) element.dataset.chips = String((shown = 0));
        return;
      }

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, element.width / dpr, element.height / dpr);
      const scene: Scene = {
        ctx,
        transform: flowStore.getState().transform,
        device,
        palette,
        hidden: state.hidden,
        wallNow,
        selected: focus?.id,
        reducedMotion: still,
      };
      if (source) drawSourceRing(scene, source.centre);
      drawRings(scene, rings);
      const drawn = drawChips(scene, places);
      if (focus) {
        const ghost: ChipPlace = {
          chip: {
            id: 0,
            event: focus,
            protocol: protocolOf(focus.frame),
            start: wallNow,
            duration: 1,
            motion: 'rest',
            drop: undefined,
            chained: false,
          },
          along: 1,
          moving: false,
          dropped: false,
          scale: 1,
          alpha: 1,
        };
        const target =
          drawn.find(({ chip }) => chip.event.id === focus.id) ?? drawChips(scene, [ghost])[0];
        if (target) drawPulse(scene, target);
      }
      painted = true;
      drawnLast = drawn;
      if (shown !== drawn.length) element.dataset.chips = String((shown = drawn.length));
    });

    return () => {
      cancelAnimationFrame(frame);
      theme.disconnect();
      sizes.disconnect();
      delete window.tracerTraffic;
    };
  }, [flowStore]);

  useEffect(() => {
    if (focusRequest === 0) return;
    const { selected, frames } = simulationStore.getState();
    const event = selected === undefined ? undefined : findFrame(frames, selected);
    if (!event) return;
    const at = restingPoint({ device: (id) => devicePlace(flowStore, id) }, event);
    if (!at) return;
    // A packet already well inside the view stays put; one near an edge or off it is centred.
    const { transform, width, height } = flowStore.getState();
    const [tx, ty, zoom] = transform;
    const x = at.x * zoom + tx;
    const y = at.y * zoom + ty;
    const comfortable = x > width * 0.2 && x < width * 0.8 && y > height * 0.2 && y < height * 0.8;
    if (comfortable) return;
    void flow.setCenter(at.x, at.y, { zoom, duration: reducedMotion() ? 0 : 300 });
  }, [focusRequest, flow, flowStore]);

  return (
    <>
      <canvas
        ref={canvas}
        aria-hidden
        data-testid="traffic-overlay"
        className="pointer-events-none absolute inset-0 z-[4] size-full"
      />
      <PduHint />
    </>
  );
}
