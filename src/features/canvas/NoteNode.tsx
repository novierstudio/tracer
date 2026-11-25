import type { NodeProps } from '@xyflow/react';
import { memo, useState, type KeyboardEvent } from 'react';
import { finishEditing } from './edit';
import type { NoteFlowNode } from './flow';

function NoteEditor({ text }: { text: string }) {
  const [value, setValue] = useState(text);
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Esc or ⌘Enter finishes, as clicking away does. Typing never reaches canvas shortcuts.
    if (event.key === 'Escape' || (event.key === 'Enter' && (event.metaKey || event.ctrlKey))) {
      event.preventDefault();
      // Handing focus back to the canvas blurs the note, which saves it, and keeps canvas keys live.
      event.currentTarget
        .closest<HTMLElement>('[aria-label="Canvas"]')
        ?.focus({ preventScroll: true });
    }
  };
  return (
    <textarea
      aria-label="Note text"
      placeholder="Write a note…"
      autoFocus
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onFocus={(event) => event.currentTarget.select()}
      onBlur={() => finishEditing(value)}
      onKeyDown={onKeyDown}
      rows={3}
      className="note-text nodrag nopan nowheel block w-full resize-none bg-transparent outline-none placeholder:text-fg-3"
    />
  );
}

export const NoteNode = memo(function NoteNode({ data }: NodeProps<NoteFlowNode>) {
  return (
    <div className="note-card" data-editing={data.editing || undefined}>
      {data.editing ? (
        <NoteEditor text={data.text} />
      ) : (
        <p className="note-text whitespace-pre-wrap">{data.text}</p>
      )}
    </div>
  );
});
