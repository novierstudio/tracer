import { CheckIcon, ChevronRightIcon, CopyIcon } from 'lucide-react';
import { Switch } from 'radix-ui';
import {
  useEffect,
  useId,
  useState,
  type ComponentProps,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import type { Result } from '@/model';
import { Button } from '@/ui/button';
import { cn } from '@/ui/cn';
import { useShowIos, type SectionIos } from './ios';
import type { IosLines } from './lines';

/** A collapsible group of settings. The heading button carries the open state for screen readers. */
export function ConfigSection({
  title,
  summary,
  children,
}: {
  title: string;
  summary?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  const bodyId = useId();
  return (
    <section aria-label={title} className="border-b border-line">
      <h3>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen(!open)}
          className="group flex h-9 w-full cursor-default items-center gap-1.5 px-3 text-left text-2xs font-medium tracking-wide text-fg-3 uppercase transition-colors outline-none hover:text-fg-1 focus-visible:text-fg-1 focus-visible:ring-2 focus-visible:ring-accent/25 focus-visible:ring-inset"
        >
          <ChevronRightIcon
            aria-hidden="true"
            className={cn('size-3 transition-transform duration-150', open && 'rotate-90')}
          />
          {title}
          {summary !== undefined && (
            <span className="ml-auto font-normal tracking-normal normal-case">{summary}</span>
          )}
        </button>
      </h3>
      {open && (
        <div id={bodyId} className="flex flex-col gap-2.5 px-3 pb-3.5">
          {children}
        </div>
      )}
    </section>
  );
}

/** A label column and a control column, so a stack of settings lines up. */
export function SettingRow({
  label,
  htmlFor,
  error,
  errorId,
  children,
}: {
  label: string;
  htmlFor?: string;
  error?: string | undefined;
  errorId?: string;
  children: ReactNode;
}) {
  return (
    <div className="grid grid-cols-[7rem_minmax(0,1fr)] items-start gap-x-3">
      <label htmlFor={htmlFor} className="pt-1.5 text-xs leading-4 text-fg-3">
        {label}
      </label>
      <div className="flex min-w-0 flex-col gap-1">
        {children}
        {error && (
          <p id={errorId} role="alert" className="text-2xs text-err">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

export function inputClass(mono: boolean, invalid: boolean) {
  return cn(
    'h-7 w-full min-w-0 rounded-md border border-line bg-surface-1 px-2 text-xs text-fg-1 transition-colors outline-none placeholder:text-fg-3/70 hover:border-line-strong focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/25',
    mono && 'font-mono text-[0.6875rem] tabular-nums',
    invalid && 'border-err/70 hover:border-err focus-visible:border-err focus-visible:ring-err/20',
  );
}

export function Select({ className, ...props }: ComponentProps<'select'>) {
  return (
    <select
      className={cn(
        'h-7 min-w-0 rounded-md border border-line bg-surface-1 px-1 text-xs text-fg-1 transition-colors outline-none hover:border-line-strong focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/25',
        className,
      )}
      {...props}
    />
  );
}

export function Toggle({
  label,
  checked,
  onChange,
  title,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  title?: string;
}) {
  return (
    <Switch.Root
      aria-label={label}
      title={title}
      checked={checked}
      onCheckedChange={onChange}
      className="relative inline-flex h-4 w-7 shrink-0 cursor-default items-center rounded-full bg-surface-3 transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-accent/40 data-[state=checked]:bg-ok/80"
    >
      <Switch.Thumb className="block size-3 translate-x-0.5 rounded-full bg-surface-1 shadow-xs transition-transform duration-150 data-[state=checked]:translate-x-3.5" />
    </Switch.Root>
  );
}

/**
 * Draft state for a text value that commits on Enter or blur, like the hostname in the header.
 * Escape reverts. An invalid value stays in the field with its error, and nothing reaches the
 * store. A multiline value commits on Ctrl/Cmd+Enter or blur, since Enter starts a new line.
 */
export function useTextDraft({
  value,
  plan,
  ios,
  multiline = false,
}: {
  value: string;
  /** The lines that set `text`, or why it is invalid. No lines means nothing to change. */
  plan: (text: string) => Result<IosLines, string>;
  ios: SectionIos;
  multiline?: boolean;
}) {
  // null while not editing, so CLI edits and undo show through.
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const errorId = useId();

  const commit = () => {
    if (draft === null) return;
    const planned = plan(draft);
    if (!planned.ok) return setError(planned.error);
    const refused = ios.commit(planned.value);
    if (refused) return setError(refused);
    setDraft(null);
    setError(undefined);
  };
  const revert = () => {
    setDraft(null);
    setError(undefined);
    ios.setPending(undefined);
  };

  return {
    error,
    errorId,
    text: draft ?? value,
    props: {
      value: draft ?? value,
      spellCheck: false,
      autoComplete: 'off',
      'aria-invalid': error !== undefined,
      'aria-describedby': error ? errorId : undefined,
      onBlur: commit,
      onChange: (event: { target: { value: string } }) => {
        const text = event.target.value;
        setDraft(text);
        setError(undefined);
        const planned = plan(text);
        ios.setPending(planned.ok ? planned.value : undefined);
      },
      onKeyDown: (event: KeyboardEvent) => {
        if (event.key === 'Enter' && (!multiline || event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          commit();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          revert();
        }
      },
    },
  };
}

export function TextSetting({
  label,
  value,
  plan,
  ios,
  mono = false,
  multiline = false,
  placeholder,
  aside,
}: {
  label: string;
  value: string;
  plan: (text: string) => Result<IosLines, string>;
  ios: SectionIos;
  mono?: boolean;
  multiline?: boolean;
  placeholder?: string;
  aside?: ReactNode;
}) {
  const draft = useTextDraft({ value, plan, ios, multiline });
  const id = useId();
  const invalid = draft.error !== undefined;
  return (
    <SettingRow label={label} htmlFor={id} error={draft.error} errorId={draft.errorId}>
      <div className="flex min-w-0 items-start gap-1.5">
        {multiline ? (
          <textarea
            id={id}
            placeholder={placeholder}
            rows={Math.min(5, Math.max(2, draft.text.split('\n').length))}
            {...draft.props}
            className={cn(inputClass(mono, invalid), 'h-auto resize-none py-1.5 leading-4')}
          />
        ) : (
          <input
            id={id}
            placeholder={placeholder}
            {...draft.props}
            className={inputClass(mono, invalid)}
          />
        )}
        {aside}
      </div>
    </SettingRow>
  );
}

/** A setting that commits the moment it changes, such as an on/off switch or a picker. */
export function useInstantCommit(ios: SectionIos) {
  const [error, setError] = useState<string>();
  return {
    error,
    run: (lines: IosLines) => setError(ios.commit(lines)),
  };
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <Button
      size="sm"
      variant="ghost"
      aria-label="Copy IOS commands"
      className="-mr-1.5 h-6 gap-1 px-1.5 text-2xs [&_svg:not([class*='size-'])]:size-3"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => setCopied(true));
      }}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
      {copied ? 'Copied' : 'Copy'}
    </Button>
  );
}

const SUB_MODES: readonly [RegExp, string][] = [
  [/^interface\s/, 'config-if'],
  [/^line\s/, 'config-line'],
  [/^vlan\s/, 'config-vlan'],
];

/** The prompt IOS would show before each line, so the preview also teaches the modes. */
export function promptsFor(hostname: string, lines: IosLines): string[] {
  let mode = 'config';
  let banner: string | undefined;
  return lines.map((line) => {
    if (banner !== undefined) {
      if (line.includes(banner)) banner = undefined;
      return '';
    }
    if (/^\s/.test(line)) return `${hostname}(${mode})#`;
    mode = SUB_MODES.find(([pattern]) => pattern.test(line))?.[1] ?? 'config';
    const opened = /^banner motd (\^C|.)(.*)$/.exec(line);
    if (opened && !opened[2]!.includes(opened[1]!)) banner = opened[1];
    return `${hostname}(config)#`;
  });
}

/**
 * The IOS behind a section: what its draft will run, or what it ran last. The prompts are
 * CSS-generated, so copying or selecting the lines gets exactly what the CLI ran.
 */
export function IosPreview({ ios, hostname }: { ios: SectionIos; hostname: string }) {
  const show = useShowIos();
  if (!show) return null;
  const lines = ios.pending ?? ios.applied;
  if (!lines) {
    return (
      <figure
        aria-label="IOS commands"
        className="rounded-md border border-dashed border-line px-2 py-1.5 text-2xs text-fg-3"
      >
        IOS commands appear here as you edit.
      </figure>
    );
  }
  const prompts = promptsFor(hostname, lines);
  return (
    <figure
      aria-label="IOS commands"
      className="overflow-hidden rounded-md border border-line bg-surface-0"
    >
      <figcaption className="flex h-7 items-center justify-between gap-2 border-b border-line pr-1.5 pl-2 text-2xs text-fg-3">
        <span className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className={cn('size-1.5 rounded-full', ios.pending ? 'bg-warn' : 'bg-ok')}
          />
          {ios.pending ? 'Will run' : 'Last run'}
        </span>
        <CopyButton text={lines.join('\n')} />
      </figcaption>
      <code className="block px-2 py-1.5 font-mono text-[0.6875rem] leading-[1.15rem] text-fg-1">
        {lines.map((line, index) => (
          <span
            key={index}
            data-prompt={prompts[index]}
            className={cn(
              'block pl-4 -indent-4 whitespace-pre-wrap wrap-anywhere before:text-fg-3 before:content-[attr(data-prompt)]',
              // Sub-mode lines keep their leading space; give top-level lines the same gap.
              !/^\s/.test(line) && prompts[index] && 'before:mr-[1ch]',
            )}
          >
            {line}
          </span>
        ))}
      </code>
    </figure>
  );
}
