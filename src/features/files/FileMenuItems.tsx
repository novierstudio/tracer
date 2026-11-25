import { FilePlusIcon, FolderOpenIcon, HistoryIcon, SaveIcon } from 'lucide-react';
import { formatShortcut } from '@/app/shell/shortcuts';
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
} from '@/ui/dropdown-menu';
import type { LabSummary } from './labStorage';
import { useFiles } from './react';
import { fileSession } from './session';

const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const day = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });

function describeLab({ updatedAt, deviceCount }: LabSummary, now = new Date()) {
  const date = new Date(updatedAt);
  const when = date.toDateString() === now.toDateString() ? time.format(date) : day.format(date);
  return `${deviceCount} ${deviceCount === 1 ? 'device' : 'devices'} · ${when}`;
}

// The File section of the app menu.
export function FileMenuItems() {
  const recents = useFiles((state) => state.recents);
  return (
    <>
      <DropdownMenuItem onSelect={() => void fileSession.newLab()}>
        <FilePlusIcon />
        New lab
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => void fileSession.open()}>
        <FolderOpenIcon />
        Open…
        <DropdownMenuShortcut>{formatShortcut('open')}</DropdownMenuShortcut>
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => void fileSession.save()}>
        <SaveIcon />
        Save
        <DropdownMenuShortcut>{formatShortcut('save')}</DropdownMenuShortcut>
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => void fileSession.saveAs()}>
        <SaveIcon />
        Save as…
        <DropdownMenuShortcut>{formatShortcut('saveAs')}</DropdownMenuShortcut>
      </DropdownMenuItem>
      {recents.length > 0 && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Recent labs</DropdownMenuLabel>
          {recents.map((lab) => (
            <DropdownMenuItem
              key={lab.id}
              onSelect={() => void fileSession.openRecent(lab)}
              className="h-auto py-1.5"
            >
              <HistoryIcon />
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{lab.name}</span>
                <span className="text-xs text-fg-3">{describeLab(lab)}</span>
              </span>
            </DropdownMenuItem>
          ))}
        </>
      )}
    </>
  );
}
