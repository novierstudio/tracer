import { lazy, Suspense, useRef, type KeyboardEvent, type ReactNode } from 'react';
import type { DeviceId } from '@/model';
import { cn } from '@/ui/cn';
import { cableTool } from './cableTool';
import { ARROWS, nudge } from './edit';

const CanvasFlow = lazy(() => import('./CanvasFlow'));

/**
 * Arrow keys on a focused device, note or selection box nudge the selection here rather than in React Flow, whose
 * own nudge re-snaps each node and moves devices and notes in separate undo steps.
 */
function onCanvasKeyDownCapture(event: KeyboardEvent<HTMLElement>) {
  if (!(event.key in ARROWS) || event.altKey || event.metaKey || event.ctrlKey) return;
  const target = event.target;
  const onNodes =
    target instanceof Element && target.closest('.react-flow__node, .react-flow__nodesselection');
  if (!onNodes || target.closest('input, textarea, [contenteditable="true"]')) return;
  event.preventDefault();
  event.stopPropagation();
  nudge(event);
}

/** Space or Enter on a focused device picks it for the cable tool, as a click would. */
function onCanvasKeyDown(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  if (!cableTool.getState().step || !(event.target instanceof Element)) return;
  const id = event.target.closest('.react-flow__node')?.getAttribute('data-id');
  if (!id) return;
  event.preventDefault();
  cableTool.getState().clickDevice(id as DeviceId);
}

// React Flow's dot grid at 100% zoom, drawn in CSS while React Flow loads.
const GRID_DOTS = {
  backgroundImage: 'radial-gradient(circle, var(--grid-dot) 0.75px, transparent 1.25px)',
  backgroundSize: '16px 16px',
};

function CanvasSkeleton() {
  return (
    <div aria-busy aria-label="Loading canvas" className="absolute inset-0" style={GRID_DOTS} />
  );
}

type CanvasProps = { fullscreen: boolean; children?: ReactNode };

export function Canvas({ fullscreen, children }: CanvasProps) {
  const ref = useRef<HTMLElement>(null);
  return (
    <main
      ref={ref}
      aria-label="Canvas"
      tabIndex={-1}
      onKeyDownCapture={onCanvasKeyDownCapture}
      onKeyDown={onCanvasKeyDown}
      onPointerDownCapture={(event) => {
        // Canvas-only shortcuts such as Select all need the canvas to hold focus after a click.
        // React also routes events from the portalled port picker here; those must be left alone.
        const canvas = ref.current;
        if (!canvas || !canvas.contains(event.target as Node)) return;
        if (!canvas.contains(document.activeElement)) canvas.focus({ preventScroll: true });
      }}
      className={cn(
        'tracer-canvas overflow-hidden bg-surface-0 outline-none',
        fullscreen ? 'fixed inset-0 z-30' : 'relative h-full',
      )}
    >
      <Suspense fallback={<CanvasSkeleton />}>
        <CanvasFlow element={ref}>{children}</CanvasFlow>
      </Suspense>
    </main>
  );
}
