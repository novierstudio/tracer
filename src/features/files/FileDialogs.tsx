import { FileUpIcon, XIcon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useRegisterCommands } from '@/features/command/registry';
import { useEditor } from '@/model/react';
import { Button } from '@/ui/button';
import { Dialog, DialogClose, DialogContent } from '@/ui/dialog';
import { fileCommands } from './fileCommands';
import { ImportDialog } from './ImportDialog';
import { useFiles } from './react';
import { fileSession } from './session';

const hasFiles = (event: DragEvent) => event.dataTransfer?.types.includes('Files') ?? false;

// Dropping a file anywhere on the window opens it.
function useFileDrop() {
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    let depth = 0;
    const enter = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      depth += 1;
      setDragging(true);
    };
    const over = (event: DragEvent) => {
      if (hasFiles(event)) event.preventDefault();
    };
    const leave = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const drop = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth = 0;
      setDragging(false);
      const file = event.dataTransfer?.files[0];
      if (file) void fileSession.openFile(file);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, []);
  return dragging;
}

function ConfirmNewLab() {
  const open = useFiles((state) => state.confirmingNew);
  const name = useEditor((state) => state.topology.meta.name);
  return (
    <Dialog open={open} onOpenChange={(next) => !next && fileSession.cancelNewLab()}>
      <DialogContent
        title="Start a new lab?"
        description={`“${name}” has changes that are not saved to a file. It stays under Recent labs in this browser.`}
      >
        <div className="flex justify-end gap-2">
          <DialogClose asChild>
            <Button>Cancel</Button>
          </DialogClose>
          <Button variant="primary" onClick={() => void fileSession.confirmNewLab()}>
            New lab
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function FileProblem() {
  const problem = useFiles((state) => state.problem);
  return (
    <Dialog open={!!problem} onOpenChange={(next) => !next && fileSession.dismissProblem()}>
      {problem && (
        <DialogContent title={problem.title} description={problem.message} role="alertdialog">
          {problem.detail && (
            <pre className="max-h-64 overflow-auto rounded-md bg-surface-2 p-3 font-mono text-xs whitespace-pre-wrap text-fg-1">
              {problem.detail}
            </pre>
          )}
          <div className="flex justify-end">
            <DialogClose asChild>
              <Button variant="primary">OK</Button>
            </DialogClose>
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}

function Notice() {
  const notice = useFiles((state) => state.notice);
  if (!notice) return null;
  return (
    <div
      role="status"
      className="fixed right-4 bottom-10 z-40 flex max-w-sm items-start gap-2 rounded-lg bg-surface-1 p-3 text-sm text-fg-1 shadow-pop"
    >
      <p className="flex-1">{notice}</p>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Dismiss"
        className="-mt-1 -mr-1"
        onClick={fileSession.dismissNotice}
      >
        <XIcon />
      </Button>
    </div>
  );
}

// Restores the last lab, autosaves, and hosts the file dialogs. Mount once.
export function FileDialogs() {
  useEffect(() => fileSession.start(), []);
  const recents = useFiles((state) => state.recents);
  useRegisterCommands(useMemo(() => fileCommands(fileSession, recents), [recents]));
  const dragging = useFileDrop();

  return (
    <>
      <ConfirmNewLab />
      <ImportDialog />
      <FileProblem />
      <Notice />
      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-50 grid place-content-center bg-accent/10 p-4">
          <div className="flex items-center gap-2 rounded-lg bg-surface-1 px-4 py-3 text-sm font-medium text-fg-1 shadow-pop">
            <FileUpIcon className="size-4 text-accent-text" />
            Drop a Tracer lab or a Packet Tracer file to open it
          </div>
        </div>
      )}
    </>
  );
}
