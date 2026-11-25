import {
  FileCodeIcon,
  FilePlusIcon,
  FolderOpenIcon,
  HistoryIcon,
  ImageIcon,
  Link2Icon,
  SaveIcon,
} from 'lucide-react';
import type { Command } from '@/features/command/registry';
import type { LabSummary } from './labStorage';
import type { FileSession } from './session';
import { chooseImage, copyShareLink, exportConfigs, exportImage } from './sharing';

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
    {
      id: 'file.share',
      title: 'Copy share link',
      group: 'File',
      keywords: ['url', 'link', 'send', 'clipboard'],
      icon: Link2Icon,
      run: () => void copyShareLink(),
    },
    {
      id: 'file.exportImage',
      title: 'Export image…',
      group: 'File',
      keywords: ['picture', 'screenshot', 'png', 'svg', 'diagram', 'assignment'],
      icon: ImageIcon,
      run: () => chooseImage(true),
    },
    {
      id: 'file.exportPng',
      title: 'Export image as PNG',
      group: 'File',
      keywords: ['picture', 'screenshot', 'diagram', 'assignment'],
      icon: ImageIcon,
      run: () => void exportImage('png', 'theme'),
    },
    {
      id: 'file.exportSvg',
      title: 'Export image as SVG',
      group: 'File',
      keywords: ['picture', 'vector', 'diagram', 'assignment'],
      icon: ImageIcon,
      run: () => void exportImage('svg', 'theme'),
    },
    {
      id: 'file.exportConfigs',
      title: 'Export running-configs',
      group: 'File',
      keywords: ['show running-config', 'config', 'zip', 'download', 'assignment'],
      icon: FileCodeIcon,
      run: () => void exportConfigs(),
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
