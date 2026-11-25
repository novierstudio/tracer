import { Command as Cmdk } from 'cmdk';
import { SearchIcon } from 'lucide-react';
import { Dialog as D } from 'radix-ui';
import { useRef, useState } from 'react';
import { formatShortcut } from '@/app/shell/shortcuts';
import { Kbd } from '@/ui/kbd';
import {
  commandRegistry,
  enabledCommands,
  groupCommands,
  loadRecents,
  matchScore,
  recentCommands,
  saveRecent,
  useCommands,
  type Command,
  type CommandRegistry,
} from './registry';

type CommandPaletteProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  registry?: CommandRegistry;
};

const headingClass =
  '[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-fg-3';

function Item({ command, value, onRun }: { command: Command; value: string; onRun: () => void }) {
  const Icon = command.icon;
  return (
    <Cmdk.Item
      value={value}
      keywords={[command.title, command.group, ...(command.keywords ?? [])]}
      onSelect={onRun}
      className="flex h-9 cursor-default items-center gap-2.5 rounded-md px-2 text-sm text-fg-1 select-none data-[selected=true]:bg-surface-2 dark:data-[selected=true]:bg-surface-3 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-fg-2"
    >
      {Icon && <Icon />}
      <span className="truncate">{command.title}</span>
      {command.shortcut && <Kbd className="ml-auto">{formatShortcut(command.shortcut)}</Kbd>}
    </Cmdk.Item>
  );
}

function PaletteBody({
  commands,
  onRun,
}: {
  commands: readonly Command[];
  onRun: (command: Command) => void;
}) {
  const [search, setSearch] = useState('');
  const [recents] = useState(loadRecents);
  const available = enabledCommands(commands);
  const recent = search ? [] : recentCommands(available, recents);

  return (
    <Cmdk
      label="Command palette"
      loop
      vimBindings={false}
      filter={(_value, search, keywords) => matchScore(search, keywords)}
      className={headingClass}
    >
      <div className="flex items-center gap-2.5 border-b border-line px-3.5">
        <SearchIcon className="size-4 shrink-0 text-fg-3" aria-hidden />
        <Cmdk.Input
          value={search}
          onValueChange={setSearch}
          placeholder="Type a command…"
          className="h-12 min-w-0 flex-1 bg-transparent text-base text-fg-1 outline-none placeholder:text-fg-3 focus-visible:outline-none"
        />
      </div>
      <Cmdk.List className="max-h-[min(60dvh,26rem)] scroll-py-1.5 overflow-y-auto p-1.5">
        <Cmdk.Empty className="px-2 py-8 text-center text-sm text-fg-3">
          No commands match “{search}”
        </Cmdk.Empty>
        {recent.length > 0 && (
          <Cmdk.Group heading="Recent">
            {recent.map((command) => (
              <Item
                key={command.id}
                command={command}
                value={`recent:${command.id}`}
                onRun={() => onRun(command)}
              />
            ))}
          </Cmdk.Group>
        )}
        {groupCommands(available).map(({ group, commands }) => (
          <Cmdk.Group key={group} heading={group}>
            {commands.map((command) => (
              <Item
                key={command.id}
                command={command}
                value={command.id}
                onRun={() => onRun(command)}
              />
            ))}
          </Cmdk.Group>
        ))}
      </Cmdk.List>
      <div className="flex items-center gap-3 border-t border-line px-3.5 py-2 text-xs text-fg-3 max-sm:hidden">
        <span className="flex items-center gap-1">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd>
          to navigate
        </span>
        <span className="flex items-center gap-1">
          <Kbd>↵</Kbd>
          to run
        </span>
        <span className="flex items-center gap-1">
          <Kbd>Esc</Kbd>
          to close
        </span>
      </div>
    </Cmdk>
  );
}

export function CommandPalette({
  open,
  onOpenChange,
  registry = commandRegistry,
}: CommandPaletteProps) {
  const commands = useCommands(registry);
  // The palette opens from a shortcut as well as a button, so Radix has no trigger to refocus.
  // It remembers what had focus and restores it on close, then runs the chosen command, so a
  // command that opens another dialog hands focus back to the same place.
  const returnFocus = useRef<HTMLElement | null>(null);
  const pending = useRef<Command | null>(null);

  const run = (command: Command) => {
    saveRecent(command.id);
    pending.current = command;
    onOpenChange(false);
  };

  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 animate-fade-in bg-black/40" />
        <D.Content
          aria-describedby={undefined}
          onOpenAutoFocus={() => {
            const active = document.activeElement;
            returnFocus.current = active instanceof HTMLElement ? active : null;
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            returnFocus.current?.focus();
            const command = pending.current;
            pending.current = null;
            command?.run();
          }}
          className="fixed top-[14dvh] left-1/2 z-50 w-[calc(100vw-2rem)] max-w-xl -translate-x-1/2 animate-fade-in overflow-hidden rounded-xl bg-surface-1 text-fg-1 shadow-pop outline-none"
        >
          <D.Title className="sr-only">Command palette</D.Title>
          <PaletteBody commands={commands} onRun={run} />
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
