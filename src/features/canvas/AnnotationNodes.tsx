import {
  NodeResizeControl,
  NodeResizer,
  ResizeControlVariant,
  type NodeProps,
} from '@xyflow/react';
import { memo, useState, type CSSProperties, type KeyboardEvent } from 'react';
import type { AnnotationColor, AnnotationKind, Size } from '@/model';
import { editorStore } from '@/model/store';
import { cn } from '@/ui/cn';
import { ANNOTATION_KINDS, colorVar, MIN_DRAWN, TEXT_SIZE_PX } from './annotations';
import { finishEditing, stopEditing } from './edit';
import type { AnnotationFlowNode } from './flow';

/** Corner radii in flow units, matching .area-box in canvas.css. */
const AREA_RADIUS = 12;
const SHAPE_RADIUS = 6;

const beginGesture = () => editorStore.getState().beginGesture();
const endGesture = () => editorStore.getState().endGesture();

const tint = (color: AnnotationColor) => ({ '--annotation': colorVar(color) }) as CSSProperties;

/** Hands focus back to the canvas, which blurs the field and so saves it, and keeps canvas keys live. */
function returnFocus(event: KeyboardEvent<HTMLElement>) {
  event.currentTarget.closest<HTMLElement>('[aria-label="Canvas"]')?.focus({ preventScroll: true });
}

type EditorProps = {
  text: string;
  label: string;
  placeholder: string;
  className?: string;
  style?: CSSProperties;
};

/** Multi-line text. Esc or ⌘Enter finishes, as clicking away does. Typing never reaches canvas keys. */
function TextEditor({ text, label, placeholder, className, style }: EditorProps) {
  const [value, setValue] = useState(text);
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape' || (event.key === 'Enter' && (event.metaKey || event.ctrlKey))) {
      event.preventDefault();
      returnFocus(event);
    }
  };
  return (
    <textarea
      aria-label={label}
      placeholder={placeholder}
      autoFocus
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onFocus={(event) => event.currentTarget.select()}
      onBlur={() => finishEditing(value)}
      onKeyDown={onKeyDown}
      rows={1}
      style={style}
      className={cn(
        'annotation-field nodrag nopan nowheel block resize-none bg-transparent outline-none placeholder:text-fg-3',
        className,
      )}
    />
  );
}

/** One line. Enter saves, Esc keeps the old text. */
function LabelEditor({ text, label, placeholder, className, style }: EditorProps) {
  const [value, setValue] = useState(text);
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter' && event.key !== 'Escape') return;
    event.preventDefault();
    if (event.key === 'Escape') stopEditing();
    returnFocus(event);
  };
  return (
    <input
      aria-label={label}
      placeholder={placeholder}
      autoFocus
      value={value}
      spellCheck={false}
      onChange={(event) => setValue(event.target.value)}
      onFocus={(event) => event.currentTarget.select()}
      onBlur={() => finishEditing(value)}
      onKeyDown={onKeyDown}
      size={Math.max(value.length, 4) + 1}
      style={style}
      className={cn('annotation-field nodrag nopan bg-transparent outline-none', className)}
    />
  );
}

const MIN_WIDTH: Record<AnnotationKind, number> = {
  note: 96,
  text: 32,
  area: MIN_DRAWN * 2,
  shape: MIN_DRAWN,
};

/** Resize handles while selected. A drag is one undo step; onNodesChange applies the new box. */
function Resizer({ kind, visible }: { kind: AnnotationKind; visible: boolean }) {
  const gesture = { onResizeStart: beginGesture, onResizeEnd: endGesture };
  if (ANNOTATION_KINDS[kind].resize === 'both') {
    return (
      <NodeResizer
        isVisible={visible}
        minWidth={MIN_WIDTH[kind]}
        minHeight={MIN_DRAWN}
        lineClassName="annotation-resize-line"
        handleClassName="annotation-resize-handle"
        {...gesture}
      />
    );
  }
  if (!visible) return null;
  // Width-only kinds grow downwards with their text, so only the sides drag.
  return (['left', 'right'] as const).map((position) => (
    <NodeResizeControl
      key={position}
      position={position}
      variant={ResizeControlVariant.Line}
      resizeDirection="horizontal"
      minWidth={MIN_WIDTH[kind]}
      className="annotation-resize-line annotation-resize-side"
      {...gesture}
    />
  ));
}

export const NoteNode = memo(function NoteNode({
  data,
  selected,
  width,
}: NodeProps<AnnotationFlowNode<'note'>>) {
  const { annotation, editing } = data;
  return (
    <>
      <div
        className="note-card"
        data-editing={editing || undefined}
        style={{ ...tint(annotation.color), width: width ?? annotation.width }}
      >
        {editing ? (
          <TextEditor
            text={annotation.text}
            label="Note text"
            placeholder="Write a note…"
            className="note-text w-full"
          />
        ) : (
          <p className="note-text whitespace-pre-wrap">{annotation.text}</p>
        )}
      </div>
      <Resizer kind="note" visible={selected && !editing} />
    </>
  );
});

export const TextNode = memo(function TextNode({
  data,
  selected,
}: NodeProps<AnnotationFlowNode<'text'>>) {
  const { annotation, editing } = data;
  const { font, line } = TEXT_SIZE_PX[annotation.textSize];
  const fixed = annotation.width !== undefined;
  const style = { fontSize: font, lineHeight: `${line}px` };
  return (
    <>
      <div
        className="text-label"
        data-wrap={fixed || undefined}
        data-editing={editing || undefined}
        style={{ ...tint(annotation.color), width: annotation.width }}
      >
        {editing ? (
          <TextEditor
            text={annotation.text}
            label="Text"
            placeholder="Type…"
            style={style}
            className="text-label-field"
          />
        ) : (
          <p style={style}>{annotation.text}</p>
        )}
      </div>
      <Resizer kind="text" visible={selected && !editing} />
    </>
  );
});

type Outline = { shape: 'rectangle' | 'ellipse'; size: Size; inset: number; radius: number };

/** A rectangle or ellipse filling the node, `inset` in from its edges. */
function OutlinePath({ shape, size, inset, radius, className }: Outline & { className: string }) {
  const width = Math.max(size.width - inset * 2, 0);
  const height = Math.max(size.height - inset * 2, 0);
  return shape === 'ellipse' ? (
    <ellipse
      cx={size.width / 2}
      cy={size.height / 2}
      rx={width / 2}
      ry={height / 2}
      className={className}
    />
  ) : (
    <rect x={inset} y={inset} width={width} height={height} rx={radius} className={className} />
  );
}

/**
 * A frame's outline, plus a wide invisible copy of it as the pointer target: the inside lets clicks
 * and drags through to whatever the frame encloses, or to the pane for a box selection.
 */
function FrameOutline({ visible, ...outline }: Outline & { visible: boolean }) {
  return (
    <svg className="frame-svg" aria-hidden>
      {visible && <OutlinePath {...outline} className="shape-line" />}
      <OutlinePath {...outline} className="frame-hit" />
    </svg>
  );
}

export const AreaNode = memo(function AreaNode({
  data,
  selected,
}: NodeProps<AnnotationFlowNode<'area'>>) {
  const { annotation, editing } = data;
  return (
    <>
      <div className="area-box" style={tint(annotation.color)}>
        <FrameOutline
          visible={false}
          shape="rectangle"
          size={annotation.size}
          inset={0}
          radius={AREA_RADIUS}
        />
        <div className="area-label">
          {editing ? (
            <LabelEditor text={annotation.label} label="Area label" placeholder="Label" />
          ) : (
            <span>{annotation.label}</span>
          )}
        </div>
      </div>
      <Resizer kind="area" visible={selected && !editing} />
    </>
  );
});

export const ShapeNode = memo(function ShapeNode({
  data,
  selected,
}: NodeProps<AnnotationFlowNode<'shape'>>) {
  const { annotation } = data;
  return (
    <>
      <div className="shape-box" style={tint(annotation.color)}>
        <FrameOutline
          visible
          shape={annotation.shape}
          size={annotation.size}
          inset={1}
          radius={SHAPE_RADIUS}
        />
      </div>
      <Resizer kind="shape" visible={selected} />
    </>
  );
});
