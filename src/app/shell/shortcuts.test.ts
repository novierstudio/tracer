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

it('undoes with Cmd or Ctrl plus Z and redoes with Shift added', () => {
  expect(press('z', { meta: true })).toBe('undo');
  expect(
    matchShortcut({ key: 'Z', metaKey: false, ctrlKey: true, altKey: false, shiftKey: true }),
  ).toBe('redo');
  expect(press('z')).toBeUndefined();
});

it('maps canvas keys, with Shift+1 and Delete as alternatives', () => {
  expect(press('1')).toBe('fitView');
  expect(press('!')).toBe('fitView');
  expect(press('c')).toBe('cableTool');
  expect(press('Backspace')).toBe('deleteSelection');
  expect(press('Delete')).toBe('deleteSelection');
  expect(press('a', { meta: true })).toBe('selectAll');
  expect(press('a')).toBeUndefined();
  expect(press('c', { meta: true })).toBeUndefined();
});
