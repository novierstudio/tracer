import { beforeEach, describe, expect, it } from 'vitest';
import {
  createCommandRegistry,
  enabledCommands,
  groupCommands,
  loadRecents,
  MAX_RECENTS,
  recentCommands,
  saveRecent,
  type Command,
  matchScore,
} from './registry';

const command = (id: string, extra: Partial<Command> = {}): Command => ({
  id,
  title: id,
  group: 'View',
  run: () => {},
  ...extra,
});

const ids = (commands: readonly Command[]) => commands.map((c) => c.id);

describe('registry', () => {
  it('lists commands by source and keeps a source in place when it re-registers', () => {
    const registry = createCommandRegistry();
    registry.set('shell', [command('a'), command('b')]);
    registry.set('canvas', [command('c')]);
    registry.set('shell', [command('a2')]);
    expect(ids(registry.getCommands())).toEqual(['a2', 'c']);

    registry.delete('shell');
    expect(ids(registry.getCommands())).toEqual(['c']);
  });

  it('notifies subscribers until they unsubscribe', () => {
    const registry = createCommandRegistry();
    let calls = 0;
    const unsubscribe = registry.subscribe(() => calls++);
    registry.set('shell', [command('a')]);
    unsubscribe();
    registry.set('shell', [command('b')]);
    expect(calls).toBe(1);
  });

  it('leaves out commands whose enabled predicate is false', () => {
    const commands = [
      command('always'),
      command('on', { enabled: () => true }),
      command('off', { enabled: () => false }),
    ];
    expect(ids(enabledCommands(commands))).toEqual(['always', 'on']);
  });

  it('groups commands in the fixed group order and drops empty groups', () => {
    const groups = groupCommands([
      command('dark', { group: 'Theme' }),
      command('palette', { group: 'View' }),
      command('light', { group: 'Theme' }),
    ]);
    expect(groups.map(({ group, commands }) => [group, ids(commands)])).toEqual([
      ['View', ['palette']],
      ['Theme', ['dark', 'light']],
    ]);
  });
});

describe('recents', () => {
  beforeEach(() => localStorage.clear());

  it('keeps the most recent first, without duplicates, and caps the list', () => {
    for (const id of ['a', 'b', 'c', 'a']) saveRecent(id);
    expect(loadRecents()).toEqual(['a', 'c', 'b']);

    for (let i = 0; i < MAX_RECENTS + 2; i++) saveRecent(`x${i}`);
    expect(loadRecents()).toHaveLength(MAX_RECENTS);
    expect(loadRecents()[0]).toBe(`x${MAX_RECENTS + 1}`);
  });

  it('ignores corrupt stored data', () => {
    localStorage.setItem('tracer.commands.recent', '{not json');
    expect(loadRecents()).toEqual([]);
    localStorage.setItem('tracer.commands.recent', JSON.stringify(['a', 3, null]));
    expect(loadRecents()).toEqual(['a']);
  });

  it('resolves recent ids to available commands only', () => {
    const available = [command('a'), command('b')];
    expect(ids(recentCommands(available, ['b', 'gone', 'a']))).toEqual(['b', 'a']);
  });
});

describe('matchScore', () => {
  const palette = ['Toggle device palette', 'View', 'panel', 'sidebar'];
  const dark = ['Dark theme', 'Theme', 'appearance', 'night'];

  it('needs every query word to start a word', () => {
    expect(matchScore('pan', dark)).toBe(0);
    expect(matchScore('pal', palette)).toBeGreaterThan(0);
    expect(matchScore('dev pal', palette)).toBeGreaterThan(0);
    expect(matchScore('dev xyz', palette)).toBe(0);
  });

  it('tolerates typos inside title words only', () => {
    expect(matchScore('drk', dark)).toBeGreaterThan(0);
    expect(matchScore('apnc', dark)).toBe(0);
  });

  it('ranks title matches above keyword-only matches', () => {
    expect(matchScore('pal', palette)).toBeGreaterThan(matchScore('pan', palette));
  });

  it('matches everything on an empty query', () => {
    expect(matchScore('  ', dark)).toBe(1);
  });
});
