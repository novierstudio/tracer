import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it } from 'vitest';
import { commandRegistry } from '@/features/command/registry';
import { emptyTopology, labSettings } from '@/model';
import { editorStore } from '@/model/store';
import { LabSettingsDialog } from './LabSettings';

beforeEach(() => {
  editorStore.getState().load(emptyTopology({ name: 'Lab', now: new Date(0) }));
});

function openFromPalette() {
  render(<LabSettingsDialog />);
  const command = commandRegistry.getCommands().find(({ title }) => title === 'Lab settings…');
  act(() => command?.run());
  return screen.getByRole('dialog', { name: 'Lab settings' });
}

it('opens from the command palette on fast timers, and switches the lab to the IOS timers', () => {
  const dialog = openFromPalette();
  const fast = screen.getByRole('radio', { name: 'Fast (default)' });
  const ios = screen.getByRole('radio', { name: 'Real IOS (30 s)' });
  expect(fast).toHaveAttribute('aria-checked', 'true');
  expect(dialog).toHaveTextContent('listen for 2 s and learn for 2 s');

  fireEvent.click(ios);

  expect(labSettings(editorStore.getState().topology).stpTimers).toBe('ios');
  expect(ios).toHaveAttribute('aria-checked', 'true');
  expect(dialog).toHaveTextContent('a new port forwards after 30 s');
  act(() => editorStore.getState().undo());
  expect(fast).toHaveAttribute('aria-checked', 'true');
});
