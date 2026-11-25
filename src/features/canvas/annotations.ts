import {
  CircleIcon,
  SquareDashedIcon,
  SquareIcon,
  StickyNoteIcon,
  TypeIcon,
  type LucideIcon,
} from 'lucide-react';
import type { ShortcutId } from '@/app/shell/shortcuts';
import {
  NOTE_WIDTH,
  type Annotation,
  type AnnotationColor,
  type AnnotationKind,
  type AnnotationSpec,
  type Point,
  type Size,
  type TextSize,
} from '@/model';
import './annotation-colors.css';
import { snap } from './geometry';

/** What each annotation kind is called and how the canvas treats it. */
type KindInfo = {
  label: string;
  /** Backdrops draw behind links and devices; overlays draw over links, under devices. */
  layer: 'backdrop' | 'overlay';
  /** Which sides a resize drags. Width-only kinds grow downwards with their text. */
  resize: 'both' | 'width';
  /**
   * Frames enclose other things, so a box selection picks one only when it covers all of it, and
   * only the frame's edge takes the pointer, leaving drags inside it to box-select what it holds.
   */
  frame: boolean;
};

export const ANNOTATION_KINDS: Record<AnnotationKind, KindInfo> = {
  note: { label: 'Note', layer: 'overlay', resize: 'width', frame: false },
  text: { label: 'Text', layer: 'overlay', resize: 'width', frame: false },
  area: { label: 'Area box', layer: 'backdrop', resize: 'both', frame: true },
  shape: { label: 'Shape', layer: 'overlay', resize: 'both', frame: true },
};

export const isFrame = (annotation: Pick<Annotation, 'kind'>) =>
  ANNOTATION_KINDS[annotation.kind].frame;

/** "Area box", or "Ellipse" for a shape. */
export function annotationLabel(annotation: AnnotationSpec): string {
  if (annotation.kind === 'shape') return annotation.shape === 'ellipse' ? 'Ellipse' : 'Rectangle';
  return ANNOTATION_KINDS[annotation.kind].label;
}

export const COLOR_LABELS: Record<AnnotationColor, string> = {
  slate: 'Slate',
  blue: 'Blue',
  teal: 'Teal',
  green: 'Green',
  amber: 'Amber',
  red: 'Red',
  purple: 'Purple',
};

/** The colour token for a palette colour, defined per theme in annotation-colors.css. */
export const colorVar = (color: AnnotationColor) => `var(--annotation-${color})`;

export const TEXT_SIZE_LABELS: Record<TextSize, string> = {
  small: 'Small',
  medium: 'Medium',
  large: 'Large',
};

/** Font size and line height in flow units. */
export const TEXT_SIZE_PX: Record<TextSize, { font: number; line: number }> = {
  small: { font: 13, line: 18 },
  medium: { font: 18, line: 24 },
  large: { font: 28, line: 34 },
};

/** The text an annotation shows, or undefined for a kind that has none. */
export function annotationText(annotation: AnnotationSpec): string | undefined {
  switch (annotation.kind) {
    case 'note':
    case 'text':
      return annotation.text;
    case 'area':
      return annotation.label;
    case 'shape':
      return undefined;
  }
}

export function withText<A extends AnnotationSpec>(annotation: A, text: string): A {
  switch (annotation.kind) {
    case 'note':
    case 'text':
      return { ...annotation, text };
    case 'area':
      return { ...annotation, label: text };
    case 'shape':
      return annotation;
  }
}

/** The annotation after a resize handle reports a new box. */
export function resized(
  annotation: Annotation,
  box: { position: Point; width?: number; height?: number },
): Annotation {
  const { position } = box;
  switch (annotation.kind) {
    case 'note':
      return { ...annotation, position, width: box.width ?? annotation.width };
    case 'text':
      return box.width === undefined
        ? { ...annotation, position }
        : { ...annotation, position, width: box.width };
    case 'area':
    case 'shape':
      return {
        ...annotation,
        position,
        size: {
          width: box.width ?? annotation.size.width,
          height: box.height ?? annotation.size.height,
        },
      };
  }
}

/** The box an annotation covers, where its size is known without measuring. */
export function annotationBox(annotation: AnnotationSpec): { position: Point; size?: Size } {
  switch (annotation.kind) {
    case 'area':
    case 'shape':
      return { position: annotation.position, size: annotation.size };
    default:
      return { position: annotation.position };
  }
}

export function annotationCentre(annotation: AnnotationSpec): Point {
  const { position, size } = annotationBox(annotation);
  return size
    ? { x: position.x + size.width / 2, y: position.y + size.height / 2 }
    : { ...position };
}

/**
 * Draw order, back to front. Area boxes come first so they sit behind everything else, the larger
 * of two overlapping areas behind the smaller, so a "VLAN 10" area inside "Building A" stays
 * visible and clickable. Other kinds keep the order they were added in.
 */
export function drawOrder<A extends AnnotationSpec>(annotations: readonly A[]): A[] {
  const surface = (annotation: A) => {
    const size = annotationBox(annotation).size;
    return size ? size.width * size.height : 0;
  };
  const backdrops = annotations
    .filter((annotation) => ANNOTATION_KINDS[annotation.kind].layer === 'backdrop')
    .sort((a, b) => surface(b) - surface(a));
  const overlays = annotations.filter(
    (annotation) => ANNOTATION_KINDS[annotation.kind].layer === 'overlay',
  );
  return [...backdrops, ...overlays];
}

/** React Flow z-index per layer. Links draw at 0, and nodes at the same z after them. */
export const LAYER_Z: Record<KindInfo['layer'], number> = { backdrop: -1, overlay: 0 };

export type AnnotationTool = 'note' | 'text' | 'area' | 'rectangle' | 'ellipse';

/** Tools that drag out a box. The others start by typing. */
export type DrawTool = Extract<AnnotationTool, 'area' | 'rectangle' | 'ellipse'>;

export const isDrawTool = (tool: AnnotationTool): tool is DrawTool =>
  tool === 'area' || tool === 'rectangle' || tool === 'ellipse';

export const ANNOTATION_TOOLS: Record<
  AnnotationTool,
  { label: string; summary: string; icon: LucideIcon; shortcut?: ShortcutId }
> = {
  note: {
    label: 'Sticky note',
    summary: 'A card of free text',
    icon: StickyNoteIcon,
    shortcut: 'addNote',
  },
  text: {
    label: 'Text',
    summary: 'A free label in three sizes',
    icon: TypeIcon,
    shortcut: 'addText',
  },
  area: {
    label: 'Area box',
    summary: 'A tinted region behind devices',
    icon: SquareDashedIcon,
    shortcut: 'addArea',
  },
  rectangle: { label: 'Rectangle', summary: 'An outline', icon: SquareIcon },
  ellipse: { label: 'Ellipse', summary: 'An outline', icon: CircleIcon, shortcut: 'addEllipse' },
};

/** A drawn box's size when the tool is clicked instead of dragged. */
export const DEFAULT_SIZE: Record<DrawTool, Size> = {
  area: { width: 384, height: 256 },
  rectangle: { width: 160, height: 96 },
  ellipse: { width: 160, height: 96 },
};

/** The smallest box a drag draws; anything smaller counts as a click. */
export const MIN_DRAWN = 24;

/** What a draw tool adds for a box, snapped to the grid. */
export function drawnSpec(tool: DrawTool, box: { position: Point; size: Size }): AnnotationSpec {
  const position = { x: snap(box.position.x), y: snap(box.position.y) };
  const size = {
    width: Math.max(snap(box.size.width), MIN_DRAWN),
    height: Math.max(snap(box.size.height), MIN_DRAWN),
  };
  if (tool === 'area') return { kind: 'area', position, size, label: 'Area', color: 'blue' };
  return { kind: 'shape', shape: tool, position, size, color: 'slate' };
}

/** A draw tool's default box centred on `at`. */
export function placedSpec(tool: DrawTool, at: Point): AnnotationSpec {
  const size = DEFAULT_SIZE[tool];
  return drawnSpec(tool, {
    position: { x: at.x - size.width / 2, y: at.y - size.height / 2 },
    size,
  });
}

/** What a typing tool starts with: an empty draft that joins the lab once it has text. */
export function draftSpec(tool: 'note' | 'text', at: Point): AnnotationSpec {
  const position = { x: snap(at.x), y: snap(at.y) };
  if (tool === 'note')
    return { kind: 'note', position, text: '', width: NOTE_WIDTH, color: 'amber' };
  return { kind: 'text', position, text: '', textSize: 'medium', color: 'slate' };
}
