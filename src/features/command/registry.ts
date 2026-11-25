import type { LucideIcon } from 'lucide-react';
import { useEffect, useId, useSyncExternalStore } from 'react';
import type { ShortcutId } from '@/app/shell/shortcuts';
import { readJson, safeStorage } from '@/app/storage';

// The palette shows groups in this order. A feature that needs a new group adds it here.
export const COMMAND_GROUPS = ['View', 'Mode', 'Theme', 'Help', 'Developer'] as const;
export type CommandGroup = (typeof COMMAND_GROUPS)[number];

export type Command = {
  id: string;
  title: string;
  group: CommandGroup;
  keywords?: readonly string[];
  icon?: LucideIcon;
  shortcut?: ShortcutId;
  // Commands that cannot run right now are left out of the palette.
  enabled?: () => boolean;
  run: () => void;
};

export type CommandRegistry = ReturnType<typeof createCommandRegistry>;

// Each source (usually one mounted component) owns a list of commands and replaces it as its
// state changes. Map keeps a source's original position when it is replaced, so order is stable.
export function createCommandRegistry() {
  const sources = new Map<string, readonly Command[]>();
  const listeners = new Set<() => void>();
  let commands: readonly Command[] = [];
  const update = () => {
    commands = [...sources.values()].flat();
    listeners.forEach((listener) => listener());
  };
  return {
    set(source: string, list: readonly Command[]) {
      sources.set(source, list);
      update();
    },
    delete(source: string) {
      if (sources.delete(source)) update();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    getCommands: () => commands,
  };
}

export const commandRegistry = createCommandRegistry();

export function useRegisterCommands(
  commands: readonly Command[],
  registry: CommandRegistry = commandRegistry,
) {
  const source = useId();
  useEffect(() => registry.set(source, commands), [registry, source, commands]);
  useEffect(() => () => registry.delete(source), [registry, source]);
}

export function useCommands(registry: CommandRegistry): readonly Command[] {
  return useSyncExternalStore(registry.subscribe, registry.getCommands);
}

export function enabledCommands(commands: readonly Command[]): Command[] {
  return commands.filter((command) => command.enabled?.() ?? true);
}

export function groupCommands(commands: readonly Command[]) {
  return COMMAND_GROUPS.map((group) => ({
    group,
    commands: commands.filter((command) => command.group === group),
  })).filter(({ commands }) => commands.length > 0);
}

const RECENTS_KEY = 'tracer.commands.recent';
export const MAX_RECENTS = 5;

export function loadRecents(): string[] {
  return (
    readJson(RECENTS_KEY, (value) =>
      Array.isArray(value) ? value.filter((id) => typeof id === 'string') : undefined,
    ) ?? []
  );
}

export function saveRecent(id: string): string[] {
  const recents = [id, ...loadRecents().filter((recent) => recent !== id)].slice(0, MAX_RECENTS);
  safeStorage.setItem(RECENTS_KEY, JSON.stringify(recents));
  return recents;
}

// Recent ids that still name an available command, most recent first.
export function recentCommands(commands: readonly Command[], recents: readonly string[]) {
  return recents.flatMap((id) => commands.find((command) => command.id === id) ?? []);
}
