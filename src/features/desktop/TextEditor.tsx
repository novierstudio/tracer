import { FilePlusIcon, SaveIcon } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { describeTopologyError, FileName } from '@/model';
import { hostFiles } from '@/model/defaults';
import { editorStore } from '@/model/store';
import { Button } from '@/ui/button';
import { cn } from '@/ui/cn';
import { saveHostFile } from './files';
import type { HostDevice } from './format';

/**
 * The desktop's Text Editor: opens a file from the host's disk, edits it, and saves it under its
 * own name or a new one.
 */
export function TextEditor({ device }: { device: HostDevice }) {
  const id = useId();
  const files = hostFiles(device.config);
  const [name, setName] = useState(() => files[0]?.name ?? '');
  const [content, setContent] = useState(() => files[0]?.content ?? '');
  const [status, setStatus] = useState<{ text: string; error: boolean }>();

  const open = (next: string) => {
    const file = files.find((candidate) => candidate.name === next);
    setName(next);
    setContent(file?.content ?? '');
    setStatus(undefined);
  };

  const save = (event: FormEvent) => {
    event.preventDefault();
    const parsed = FileName.safeParse(name);
    if (!parsed.success) {
      return setStatus({ text: parsed.error.issues[0]?.message ?? 'Bad file name', error: true });
    }
    const saved = saveHostFile(editorStore, device.id, { name: parsed.data, content });
    if (saved && !saved.ok) {
      return setStatus({ text: describeTopologyError(saved.error), error: true });
    }
    setName(parsed.data);
    setStatus({ text: `Saved ${parsed.data}`, error: false });
  };

  const known = files.some((file) => file.name === name);
  return (
    <form
      aria-label="Text Editor"
      onSubmit={save}
      className="flex min-h-0 flex-1 flex-col gap-2 px-3 py-3"
    >
      <div className="flex items-end gap-1.5">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <label htmlFor={`${id}-open`} className="text-2xs text-fg-3">
            Open
          </label>
          <select
            id={`${id}-open`}
            value={known ? name : ''}
            onChange={(event) => open(event.target.value)}
            className="h-7 w-full min-w-0 rounded-md border border-line bg-surface-1 px-1.5 font-mono text-[0.6875rem] text-fg-1"
          >
            {!known && <option value="">New file</option>}
            {files.map((file) => (
              <option key={file.name} value={file.name}>
                {file.name}
              </option>
            ))}
          </select>
        </div>
        <Button type="button" size="sm" onClick={() => open('')}>
          <FilePlusIcon />
          New
        </Button>
      </div>
      <textarea
        aria-label="File contents"
        value={content}
        onChange={(event) => setContent(event.target.value)}
        spellCheck={false}
        className="min-h-40 flex-1 resize-none rounded-md border border-line bg-surface-1 p-2 font-mono text-[0.6875rem] text-fg-1 outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/25"
      />
      <div className="flex items-end gap-1.5">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <label htmlFor={`${id}-name`} className="text-2xs text-fg-3">
            Save as
          </label>
          <input
            id={`${id}-name`}
            value={name}
            placeholder="notes.txt"
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => {
              setName(event.target.value);
              setStatus(undefined);
            }}
            className="h-7 w-full min-w-0 rounded-md border border-line bg-surface-1 px-2 font-mono text-[0.6875rem] text-fg-1 outline-none hover:border-line-strong focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/25"
          />
        </div>
        <Button type="submit" size="sm" variant="primary">
          <SaveIcon />
          Save
        </Button>
      </div>
      <p role="status" className={cn('min-h-4 text-2xs', status?.error ? 'text-err' : 'text-fg-3')}>
        {status?.text}
      </p>
    </form>
  );
}
