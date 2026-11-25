import { CheckIcon, Trash2Icon } from 'lucide-react';
import { useState, type KeyboardEvent } from 'react';
import {
  ANNOTATION_TOOLS,
  annotationLabel,
  annotationText,
  COLOR_LABELS,
  colorVar,
  MIN_DRAWN,
  TEXT_SIZE_LABELS,
  withText,
  type AnnotationTool,
} from '@/features/canvas/annotations';
import { ANNOTATION_COLORS, SHAPES, TEXT_SIZES, type Annotation } from '@/model';
import { editorStore } from '@/model/store';
import { Button } from '@/ui/button';
import { cn } from '@/ui/cn';
import { Segmented } from '@/ui/segmented';
import { deleteItems } from './actions';
import { Section } from './parts';

const update = (next: Annotation) => editorStore.getState().updateAnnotation(next);

/** The tool that makes this annotation, for its icon. */
const toolFor = (annotation: Annotation): AnnotationTool =>
  annotation.kind === 'shape' ? annotation.shape : annotation.kind;

const PLACEMENT: Record<Annotation['kind'], string> = {
  note: 'Over links, under devices',
  text: 'Over links, under devices',
  area: 'Behind devices and links',
  shape: 'Over links, under devices',
};

const fieldClass =
  'w-full min-w-0 rounded-md border border-line bg-surface-1 px-2 text-xs text-fg-1 transition-colors outline-none placeholder:text-fg-3/70 hover:border-line-strong focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/25';

/**
 * Saves on blur, Enter for one line or ⌘Enter for several; Esc reverts. Each save is one undo step.
 * Notes and text keep their old words rather than save empty, since clearing on the canvas deletes.
 */
function TextField({ annotation }: { annotation: Annotation }) {
  const current = annotationText(annotation) ?? '';
  const [draft, setDraft] = useState<string | null>(null);
  const multiline = annotation.kind !== 'area';
  const commit = () => {
    if (draft === null) return;
    setDraft(null);
    const text = multiline ? draft.trimEnd() : draft.trim();
    if (text === current || (multiline && !text.trim())) return;
    update(withText(annotation, text));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const finish = event.key === 'Enter' && (!multiline || event.metaKey || event.ctrlKey);
    if (event.key === 'Escape') {
      event.preventDefault();
      setDraft(null);
    } else if (finish) {
      event.preventDefault();
      commit();
    }
  };
  const props = {
    id: 'annotation-text',
    value: draft ?? current,
    onChange: (event: { target: { value: string } }) => setDraft(event.target.value),
    onBlur: commit,
    onKeyDown,
  };
  const label = annotation.kind === 'area' ? 'Label' : 'Text';
  return (
    <Section title={label} className="border-t border-line">
      <label htmlFor="annotation-text" className="sr-only">
        {label}
      </label>
      {multiline ? (
        <textarea {...props} rows={3} className={cn(fieldClass, 'resize-y py-1.5 leading-5')} />
      ) : (
        <input {...props} spellCheck={false} autoComplete="off" className={cn(fieldClass, 'h-7')} />
      )}
    </Section>
  );
}

function ColorPicker({ annotation }: { annotation: Annotation }) {
  return (
    <Section title="Colour" className="border-t border-line">
      <div role="radiogroup" aria-label="Colour" className="flex flex-wrap gap-1.5">
        {ANNOTATION_COLORS.map((color) => {
          const checked = annotation.color === color;
          return (
            <button
              key={color}
              type="button"
              role="radio"
              aria-checked={checked}
              aria-label={COLOR_LABELS[color]}
              title={COLOR_LABELS[color]}
              onClick={() => update({ ...annotation, color })}
              className={cn(
                'flex size-6 cursor-default items-center justify-center rounded-full ring-1 ring-black/10 transition-shadow ring-inset outline-none focus-visible:ring-2 focus-visible:ring-accent dark:ring-white/15',
                checked && 'ring-2 ring-fg-1 ring-offset-2 ring-offset-surface-1 dark:ring-fg-1',
              )}
              style={{ background: colorVar(color) }}
            >
              {checked && <CheckIcon className="size-3.5 text-white" strokeWidth={3} />}
            </button>
          );
        })}
      </div>
    </Section>
  );
}

/** A whole number of flow units, saved on blur or Enter. */
function Dimension({
  label,
  value,
  min,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    setDraft(null);
    const parsed = Math.round(Number(draft));
    if (Number.isFinite(parsed) && parsed !== Math.round(value)) onCommit(Math.max(parsed, min));
  };
  const id = `annotation-${label.toLowerCase()}`;
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <label htmlFor={id} className="text-2xs text-fg-3">
        {label}
      </label>
      <input
        id={id}
        inputMode="numeric"
        value={draft ?? String(Math.round(value))}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit();
          if (event.key === 'Escape') setDraft(null);
        }}
        className={cn(fieldClass, 'h-7 font-mono tabular-nums')}
      />
    </div>
  );
}

function SizeSection({ annotation }: { annotation: Annotation }) {
  switch (annotation.kind) {
    case 'text':
      return (
        <Section title="Size" className="border-t border-line">
          <Segmented
            label="Text size"
            value={annotation.textSize}
            onValueChange={(textSize) => update({ ...annotation, textSize })}
            options={TEXT_SIZES.map((size) => ({ value: size, label: TEXT_SIZE_LABELS[size] }))}
            className="self-start"
          />
        </Section>
      );
    case 'note':
      return (
        <Section title="Size" className="border-t border-line">
          <div className="flex gap-2">
            <Dimension
              label="Width"
              value={annotation.width}
              min={96}
              onCommit={(width) => update({ ...annotation, width })}
            />
          </div>
        </Section>
      );
    case 'area':
    case 'shape':
      return (
        <Section title="Size" className="border-t border-line">
          {annotation.kind === 'shape' && (
            <Segmented
              label="Shape"
              value={annotation.shape}
              onValueChange={(shape) => update({ ...annotation, shape })}
              options={SHAPES.map((shape) => ({
                value: shape,
                label: shape === 'ellipse' ? 'Ellipse' : 'Rectangle',
              }))}
              className="self-start"
            />
          )}
          <div className="flex gap-2">
            {(['width', 'height'] as const).map((side) => (
              <Dimension
                key={side}
                label={side === 'width' ? 'Width' : 'Height'}
                value={annotation.size[side]}
                min={MIN_DRAWN}
                onCommit={(value) =>
                  update({ ...annotation, size: { ...annotation.size, [side]: value } })
                }
              />
            ))}
          </div>
        </Section>
      );
  }
}

/** One annotation: what it is, its text, colour and size, and a way to delete it. */
export function AnnotationInspector({ annotation }: { annotation: Annotation }) {
  const label = annotationLabel(annotation);
  const Icon = ANNOTATION_TOOLS[toolFor(annotation)].icon;
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <header className="flex items-center gap-3 px-3 pt-1 pb-3">
        <span
          className="flex size-10 shrink-0 items-center justify-center rounded-[11px] border border-line-strong bg-surface-2"
          style={{ color: colorVar(annotation.color) }}
        >
          <Icon className="size-5" strokeWidth={1.75} />
        </span>
        <div className="flex min-w-0 flex-col">
          <h3 className="truncate text-base font-semibold text-fg-1">{label}</h3>
          <p className="text-xs text-fg-2">{PLACEMENT[annotation.kind]}</p>
        </div>
      </header>
      {annotationText(annotation) !== undefined && <TextField annotation={annotation} />}
      <ColorPicker annotation={annotation} />
      <SizeSection annotation={annotation} />
      <div className="border-t border-line px-3 py-3">
        <Button size="sm" onClick={() => deleteItems([], [], [annotation.id])}>
          <Trash2Icon />
          Delete {label.toLowerCase()}
        </Button>
      </div>
    </div>
  );
}
