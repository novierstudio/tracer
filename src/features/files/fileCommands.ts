import { FilePlusIcon, FolderOpenIcon, HistoryIcon, SaveIcon } from 'lucide-react';
import type { Command } from '@/features/command/registry';
import type { LabSummary } from './labStorage';
import type { FileSession } from './session';

export function fileCommands(session: FileSession, recents: readonly LabSummary[]): Command[] {
  return [
    {
      id: 'file.new',
      title: 'New lab',
      group: 'File',
      keywords: ['create', 'blank', 'empty', 'project'],
      icon: FilePlusIcon,
      run: () => void session.newLab(),
    },
    {
      id: 'file.open',
      title: 'Open lab…',
      group: 'File',
      keywords: ['load', 'import', 'file', 'tracer.json', 'packet tracer', 'pkt', 'pka'],
      icon: FolderOpenIcon,
      shortcut: 'open',
      run: () => void session.open(),
    },
    {
      id: 'file.save',
      title: 'Save lab',
      group: 'File',
      keywords: ['download', 'export', 'file', 'tracer.json'],
      icon: SaveIcon,
      shortcut: 'save',
      run: () => void session.save(),
    },
    {
      id: 'file.saveAs',
      title: 'Save lab as…',
      group: 'File',
      keywords: ['download', 'export', 'copy', 'file', 'tracer.json'],
      icon: SaveIcon,
      shortcut: 'saveAs',
      run: () => void session.saveAs(),
    },
    ...recents.map((lab): Command => ({
      id: `file.recent.${lab.id}`,
      title: `Open recent: ${lab.name}`,
      group: 'File',
      keywords: ['recent', 'history', 'lab'],
      icon: HistoryIcon,
      run: () => void session.openRecent(lab),
    })),
  ];
}
