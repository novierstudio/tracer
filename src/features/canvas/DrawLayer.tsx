import { useReactFlow } from '@xyflow/react';
import { useRef, useState, type PointerEvent } from 'react';
import { MIN_DRAWN, type DrawTool } from './annotations';
import { useCanvasUi } from './canvasUi';
import { drawAnnotation, placeAnnotation } from './edit';

type Drag = { pointer: number; start: { x: number; y: number }; end: { x: number; y: number } };

/**
 * While a draw tool is armed, this layer over the pane takes the pointer: a drag draws the box, and
 * a click places the tool's default box centred there. Either way the tool disarms.
 */
export function DrawLayer() {
  const tool = useCanvasUi((state) => state.drawing);
  if (!tool) return null;
  return <Layer tool={tool} />;
}

function Layer({ tool }: { tool: DrawTool }) {
  const flow = useReactFlow();
  const layer = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);

  const local = (event: PointerEvent) => {
    const rect = layer.current?.getBoundingClientRect();
    return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) };
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const at = local(event);
    setDrag({ pointer: event.pointerId, start: at, end: at });
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (drag?.pointer === event.pointerId) setDrag({ ...drag, end: local(event) });
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (drag?.pointer !== event.pointerId) return;
    setDrag(null);
    const rect = layer.current?.getBoundingClientRect();
    const toFlow = (p: { x: number; y: number }) =>
      flow.screenToFlowPosition({ x: p.x + (rect?.left ?? 0), y: p.y + (rect?.top ?? 0) });
    const end = local(event);
    const dragged =
      Math.abs(end.x - drag.start.x) >= MIN_DRAWN || Math.abs(end.y - drag.start.y) >= MIN_DRAWN;
    if (!dragged) {
      placeAnnotation(tool, toFlow(end));
      return;
    }
    const a = toFlow(drag.start);
    const b = toFlow(end);
    drawAnnotation(tool, {
      position: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) },
      size: { width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) },
    });
  };

  const preview = drag && {
    left: Math.min(drag.start.x, drag.end.x),
    top: Math.min(drag.start.y, drag.end.y),
    width: Math.abs(drag.end.x - drag.start.x),
    height: Math.abs(drag.end.y - drag.start.y),
  };

  return (
    <div
      ref={layer}
      className="draw-layer"
      aria-hidden
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => setDrag(null)}
    >
      {preview && <div className="draw-preview" data-tool={tool} style={preview} />}
    </div>
  );
}
