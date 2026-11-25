import { CheckIcon, ChevronDownIcon, XIcon } from 'lucide-react';
import { useState } from 'react';
import { useStore } from 'zustand';
import { sampleNamed } from '@/labs/catalog';
import { useEditor } from '@/model/react';
import { Button } from '@/ui/button';
import { cn } from '@/ui/cn';
import { onboarding } from './store';

/** A step's text, with each `backticked` part shown as something to type. */
function StepText({ text }: { text: string }) {
  return text.split('`').map((part, index) =>
    index % 2 === 1 ? (
      <code
        key={index}
        className="rounded-sm bg-surface-2 px-1 py-px font-mono text-[0.6875rem] text-fg-1"
      >
        {part}
      </code>
    ) : (
      part
    ),
  );
}

/**
 * The open sample's "Try this" steps, in the canvas corner. The user ticks them; nothing is
 * detected for them. Loaded on its own so the lab catalog stays out of the main bundle.
 */
export default function TryThisCard({ hidden }: { hidden: boolean }) {
  const lab = sampleNamed(useEditor((editor) => editor.topology.meta.name));
  const checklist = useStore(onboarding.store, (state) => lab && state.checklists[lab.id]);
  const [expanded, setExpanded] = useState(true);
  if (!lab || hidden || checklist?.dismissed) return null;
  const done = checklist?.done ?? [];
  const finished = done.length === lab.tryThis.length;
  return (
    <section
      aria-label="Try this"
      className="absolute top-3 left-3 z-10 w-72 animate-fade-in rounded-xl bg-surface-1/95 p-3 shadow-pop backdrop-blur-sm"
    >
      <div className="flex items-start justify-between gap-2 pl-1">
        <div className="flex min-w-0 flex-col">
          <h2 className="text-xs font-semibold text-fg-1">Try this</h2>
          <p className="truncate text-2xs text-fg-3">{lab.title}</p>
        </div>
        <div className="flex items-center gap-0.5">
          <span className="text-2xs text-fg-3 tabular-nums" aria-label="Progress">
            {done.length}/{lab.tryThis.length}
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={expanded ? 'Collapse checklist' : 'Expand checklist'}
            aria-expanded={expanded}
            className="-mt-0.5"
            onClick={() => setExpanded(!expanded)}
          >
            <ChevronDownIcon
              className={cn('transition-transform duration-150', !expanded && '-rotate-90')}
            />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Close checklist"
            className="-mt-0.5 -mr-1"
            onClick={() => onboarding.dismissChecklist(lab.id)}
          >
            <XIcon />
          </Button>
        </div>
      </div>
      {expanded && (
        <>
          <ul className="mt-2 flex flex-col">
            {lab.tryThis.map((step, index) => {
              const checked = done.includes(index);
              return (
                <li key={step}>
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={checked}
                    onClick={() => onboarding.toggleStep(lab.id, index)}
                    className="flex w-full cursor-default items-start gap-2.5 rounded-md px-1 py-1.5 text-left text-xs transition-colors outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-accent"
                  >
                    <span
                      className={cn(
                        'mt-px flex size-4 shrink-0 items-center justify-center rounded-[5px] border transition-colors',
                        checked ? 'border-accent bg-accent text-accent-fg' : 'border-line-strong',
                      )}
                    >
                      {checked && <CheckIcon className="size-3" strokeWidth={3} />}
                    </span>
                    <span className={cn('leading-snug', checked ? 'text-fg-3' : 'text-fg-2')}>
                      <StepText text={step} />
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          <p className="mt-2 border-t border-line px-1 pt-2 text-2xs text-fg-3">
            {finished ? (
              <>
                All done.{' '}
                <button
                  type="button"
                  onClick={onboarding.openGallery}
                  className="cursor-default text-accent-text underline-offset-2 hover:underline"
                >
                  Open another sample lab
                </button>
              </>
            ) : (
              'Wait for the link lights to turn green, then ping.'
            )}
          </p>
        </>
      )}
    </section>
  );
}
