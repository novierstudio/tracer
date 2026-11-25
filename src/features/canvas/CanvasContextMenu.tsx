import {
  CableIcon,
  ClipboardPasteIcon,
  MonitorIcon,
  PencilIcon,
  PowerIcon,
  StickyNoteIcon,
  TerminalIcon,
  Trash2Icon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { formatShortcut } from '@/app/shell/shortcuts';
import type { Command } from '@/features/command/registry';
import { openDeviceConsole } from '@/features/inspector/requests';
import type { AnnotationId, DeviceId, LinkId, Point } from '@/model';
import { useEditor } from '@/model/react';
import { editorStore } from '@/model/store';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/ui/context-menu';
import { CABLE_LABELS } from './cables';
import { cableTool } from './cableTool';
import { addNote, canvasCommands, placeDevice, QUICK_ADD } from './controller';
import { canPaste, deleteSelection, editNote, paste, startRename } from './edit';

/** What was right-clicked, and where on the canvas. */
export type MenuTarget = { at: Point } & (
  | { kind: 'device'; device: DeviceId }
  | { kind: 'link'; link: LinkId }
  | { kind: 'note'; note: AnnotationId }
  | { kind: 'selection' }
  | { kind: 'pane' }
);

const COMMANDS = new Map(canvasCommands.map((command) => [command.id, command]));

/** A canvas command as a menu item, so its title, icon and shortcut match the palette's. */
function CommandItem({ id, destructive }: { id: string; destructive?: boolean }) {
  const { title, icon: Icon, shortcut, enabled, run } = COMMANDS.get(id) as Command;
  return (
    <ContextMenuItem destructive={destructive} disabled={!(enabled?.() ?? true)} onSelect={run}>
      {Icon && <Icon />}
      {title}
      {shortcut && <ContextMenuShortcut>{formatShortcut(shortcut)}</ContextMenuShortcut>}
    </ContextMenuItem>
  );
}

function ArrangeSub() {
  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger>Align and distribute</ContextMenuSubTrigger>
      <ContextMenuSubContent>
        {['left', 'centre', 'right', 'top', 'middle', 'bottom'].map((edge) => (
          <CommandItem key={edge} id={`arrange.align.${edge}`} />
        ))}
        <ContextMenuSeparator />
        <CommandItem id="arrange.distribute.horizontal" />
        <CommandItem id="arrange.distribute.vertical" />
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}

const ClipboardItems = () => (
  <>
    <CommandItem id="edit.copy" />
    <CommandItem id="edit.cut" />
    <CommandItem id="edit.duplicate" />
  </>
);

const DeleteItem = ({ label }: { label: string }) => (
  <ContextMenuItem destructive onSelect={deleteSelection}>
    <Trash2Icon />
    {label}
    <ContextMenuShortcut>{formatShortcut('deleteSelection')}</ContextMenuShortcut>
  </ContextMenuItem>
);

function startCable(device: DeviceId) {
  if (!cableTool.getState().step) cableTool.getState().toggle();
  cableTool.getState().clickDevice(device);
}

function DeviceItems({ device: id }: { device: DeviceId }) {
  const device = useEditor((state) => state.topology.devices[id]);
  if (!device) return null;
  const host = device.kind === 'pc' || device.kind === 'server';
  return (
    <>
      <ContextMenuItem onSelect={() => openDeviceConsole(id)}>
        {host ? <MonitorIcon /> : <TerminalIcon />}
        {host ? 'Open Desktop' : 'Open CLI'}
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => startCable(id)}>
        <CableIcon />
        Connect…
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => startRename(id)}>
        <PencilIcon />
        Rename
        <ContextMenuShortcut>{formatShortcut('rename')}</ContextMenuShortcut>
      </ContextMenuItem>
      <ContextMenuItem
        onSelect={() => editorStore.getState().setPowered({ device: id, powered: !device.powered })}
      >
        <PowerIcon />
        {device.powered ? 'Power off' : 'Power on'}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ClipboardItems />
      <ContextMenuSeparator />
      <DeleteItem label="Delete device" />
    </>
  );
}

function LinkItems({ link: id }: { link: LinkId }) {
  const link = useEditor((state) => state.topology.links[id]);
  if (!link) return null;
  const choose = (cable: string) => {
    if (cable !== 'straight' && cable !== 'crossover') return;
    const result = editorStore.getState().setLinkCable({ link: id, cable });
    if (!result.ok) cableTool.getState().notify('That cable does not fit these ports.');
  };
  return (
    <>
      {link.cable !== 'serial' && (
        <>
          <ContextMenuRadioGroup value={link.cable} onValueChange={choose}>
            {(['straight', 'crossover'] as const).map((cable) => (
              <ContextMenuRadioItem key={cable} value={cable}>
                {CABLE_LABELS[cable]}
              </ContextMenuRadioItem>
            ))}
          </ContextMenuRadioGroup>
          <ContextMenuSeparator />
        </>
      )}
      <DeleteItem label="Delete cable" />
    </>
  );
}

function NoteItems({ note }: { note: AnnotationId }) {
  return (
    <>
      <ContextMenuItem onSelect={() => editNote(note)}>
        <PencilIcon />
        Edit note
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ClipboardItems />
      <ContextMenuSeparator />
      <DeleteItem label="Delete note" />
    </>
  );
}

function SelectionItems() {
  return (
    <>
      <ArrangeSub />
      <ContextMenuSeparator />
      <ClipboardItems />
      <ContextMenuSeparator />
      <DeleteItem label="Delete selection" />
    </>
  );
}

function PaneItems({ at }: { at: Point }) {
  return (
    <>
      <ContextMenuItem disabled={!canPaste()} onSelect={() => paste(at)}>
        <ClipboardPasteIcon />
        Paste here
        <ContextMenuShortcut>{formatShortcut('paste')}</ContextMenuShortcut>
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => addNote(at)}>
        <StickyNoteIcon />
        Add note here
        <ContextMenuShortcut>{formatShortcut('addNote')}</ContextMenuShortcut>
      </ContextMenuItem>
      {(Object.keys(QUICK_ADD) as (keyof typeof QUICK_ADD)[]).map((id) => {
        const { model, label, icon: Icon } = QUICK_ADD[id];
        return (
          <ContextMenuItem key={id} onSelect={() => placeDevice(model, at)}>
            <Icon />
            Add {label} here
            <ContextMenuShortcut>{formatShortcut(id)}</ContextMenuShortcut>
          </ContextMenuItem>
        );
      })}
      <ContextMenuSeparator />
      <CommandItem id="edit.selectAll" />
      <CommandItem id="arrange.autoLayout" />
      <CommandItem id="view.fitView" />
    </>
  );
}

function MenuItems({ target }: { target: MenuTarget }) {
  switch (target.kind) {
    case 'device':
      return <DeviceItems device={target.device} />;
    case 'link':
      return <LinkItems link={target.link} />;
    case 'note':
      return <NoteItems note={target.note} />;
    case 'selection':
      return <SelectionItems />;
    case 'pane':
      return <PaneItems at={target.at} />;
  }
}

type Props = { target: MenuTarget | null; children: ReactNode };

/** Right-click menus for devices, links, notes, a multi-selection and the empty canvas. */
export function CanvasContextMenu({ target, children }: Props) {
  return (
    <ContextMenu modal={false}>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent aria-label="Canvas menu" className="min-w-52">
        {target && <MenuItems target={target} />}
      </ContextMenuContent>
    </ContextMenu>
  );
}
