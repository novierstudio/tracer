import { CheckIcon, CloudOffIcon, LoaderIcon } from 'lucide-react';
import { cn } from '@/ui/cn';
import type { SaveStatus as Status } from './autosave';
import { useFiles } from './react';

const VIEWS: Record<Status, { label: string; icon: typeof CheckIcon; className?: string }> = {
  saved: { label: 'Saved', icon: CheckIcon },
  saving: { label: 'Saving…', icon: LoaderIcon },
  unavailable: {
    label: 'Not saved: storage unavailable',
    icon: CloudOffIcon,
    className: 'text-warn',
  },
  full: { label: 'Not saved: storage full', icon: CloudOffIcon, className: 'text-warn' },
};

export function SaveStatus() {
  const status = useFiles((state) => state.status);
  const { label, icon: Icon, className } = VIEWS[status];
  return (
    <span
      title="Changes autosave in this browser. Save a .tracer.json file to keep a copy elsewhere."
      className={cn('flex items-center gap-1 px-1.5', className)}
    >
      <Icon className="size-3" aria-hidden />
      {label}
    </span>
  );
}
