import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { CommandPalette } from './CommandPalette';
import { createCommandRegistry, type Command } from './registry';

beforeAll(() => {
  // jsdom has no layout; cmdk measures its list and scrolls the selected item into view.
  Element.prototype.scrollIntoView = () => {};
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

beforeEach(() => localStorage.clear());

function setup(commands: Command[]) {
  const registry = createCommandRegistry();
  registry.set('test', commands);
  function Harness() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button onClick={() => setOpen(true)}>Open palette</button>
        <CommandPalette open={open} onOpenChange={setOpen} registry={registry} />
      </>
    );
  }
  render(<Harness />);
  const opener = screen.getByRole('button', { name: 'Open palette' });
  const open = () => {
    opener.focus();
    fireEvent.click(opener);
    return screen.getByRole('dialog', { name: 'Command palette' });
  };
  const input = () => screen.getByRole('combobox');
  const type = (text: string) => fireEvent.change(input(), { target: { value: text } });
  const press = (key: string) => fireEvent.keyDown(document.activeElement!, { key });
  const titles = () => screen.queryAllByRole('option').map((option) => option.textContent);
  return { opener, open, input, type, press, titles };
}

const command = (id: string, title: string, extra: Partial<Command> = {}): Command => ({
  id,
  title,
  group: 'View',
  run: vi.fn(),
  ...extra,
});

it('opens as a labelled dialog with the search field focused', () => {
  const { open, input } = setup([command('a', 'Toggle inspector')]);
  open();
  expect(input()).toHaveFocus();
});

it('filters fuzzily over titles and keywords', () => {
  const { open, type, titles } = setup([
    command('dark', 'Dark theme', { group: 'Theme' }),
    command('light', 'Light theme', { group: 'Theme' }),
    command('help', 'Keyboard shortcuts', { group: 'Help', keywords: ['cheat sheet'] }),
  ]);
  open();
  expect(titles()).toEqual(['Dark theme', 'Light theme', 'Keyboard shortcuts']);

  type('drk');
  expect(titles()).toEqual(['Dark theme']);

  type('cheat');
  expect(titles()).toEqual(['Keyboard shortcuts']);

  type('zzz');
  expect(titles()).toEqual([]);
  expect(screen.getByText(/No commands match/)).toBeInTheDocument();
});

it('hides commands that are not enabled', () => {
  const { open, titles } = setup([
    command('sim', 'Switch to Simulation mode', { enabled: () => true }),
    command('real', 'Switch to Realtime mode', { enabled: () => false }),
  ]);
  open();
  expect(titles()).toEqual(['Switch to Simulation mode']);
});

it('runs the highlighted command on Enter, closes and returns focus', async () => {
  const dark = command('dark', 'Dark theme');
  const light = command('light', 'Light theme');
  const { open, opener, type, press } = setup([dark, light]);
  open();
  type('light');
  press('Enter');

  await waitFor(() => expect(light.run).toHaveBeenCalledOnce());
  expect(dark.run).not.toHaveBeenCalled();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(opener).toHaveFocus();
});

it('moves through commands with the arrow keys', async () => {
  const first = command('first', 'First');
  const second = command('second', 'Second');
  const { open, press } = setup([first, second]);
  open();
  press('ArrowDown');
  press('Enter');
  await waitFor(() => expect(second.run).toHaveBeenCalledOnce());
});

it('closes on Escape without running anything and returns focus', async () => {
  const a = command('a', 'Toggle inspector');
  const { open, opener, press } = setup([a]);
  open();
  press('Escape');
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(opener).toHaveFocus();
  expect(a.run).not.toHaveBeenCalled();
});

it('lists recently run commands first, and only while the search is empty', async () => {
  const { open, type, press, titles } = setup([
    command('palette', 'Toggle device palette'),
    command('inspector', 'Toggle inspector'),
  ]);
  open();
  type('inspector');
  press('Enter');
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

  open();
  expect(screen.getByRole('group', { name: 'Recent' })).toBeInTheDocument();
  expect(titles()).toEqual(['Toggle inspector', 'Toggle device palette', 'Toggle inspector']);

  type('toggle');
  expect(screen.queryByRole('group', { name: 'Recent' })).not.toBeInTheDocument();
});
