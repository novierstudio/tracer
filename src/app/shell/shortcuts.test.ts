import { expect, it } from 'vitest';
import { matchShortcut } from './shortcuts';

const press = (key: string, mods: { meta?: boolean; ctrl?: boolean; alt?: boolean } = {}) =>
  matchShortcut({
    key,
    metaKey: mods.meta ?? false,
    ctrlKey: mods.ctrl ?? false,
    altKey: mods.alt ?? false,
  });

it('maps bare keys to panel and focus shortcuts', () => {
  expect(press('[')).toBe('togglePalette');
  expect(press(']')).toBe('toggleInspector');
  expect(press('`')).toBe('toggleBottom');
  expect(press('f')).toBe('focusMode');
  expect(press('F')).toBe('focusMode');
  expect(press('?')).toBe('showShortcuts');
});

it('opens the command palette with Cmd or Ctrl plus K', () => {
  expect(press('k', { meta: true })).toBe('commandPalette');
  expect(press('K', { ctrl: true })).toBe('commandPalette');
  expect(press('k')).toBeUndefined();
});

it('switches mode with Cmd or Ctrl plus Enter only', () => {
  expect(press('Enter', { meta: true })).toBe('toggleMode');
  expect(press('Enter', { ctrl: true })).toBe('toggleMode');
  expect(press('Enter')).toBeUndefined();
});

it('leaves browser and OS combinations alone', () => {
  expect(press('f', { ctrl: true })).toBeUndefined();
  expect(press('[', { meta: true })).toBeUndefined();
  expect(press('f', { alt: true })).toBeUndefined();
  expect(press('x')).toBeUndefined();
});
