import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, expect, it } from 'vitest';
import { OSPF_TIMERS } from '@/engine/routing/timers';
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
  const group = within(screen.getByRole('radiogroup', { name: 'Spanning tree timers' }));
  const fast = group.getByRole('radio', { name: 'Fast (default)' });
  const ios = group.getByRole('radio', { name: 'Real IOS (30 s)' });
  expect(fast).toHaveAttribute('aria-checked', 'true');
  expect(dialog).toHaveTextContent('listen for 2 s and learn for 2 s');

  fireEvent.click(ios);

  expect(labSettings(editorStore.getState().topology).stpTimers).toBe('ios');
  expect(ios).toHaveAttribute('aria-checked', 'true');
  expect(dialog).toHaveTextContent('a new port forwards after 30 s');
  act(() => editorStore.getState().undo());
  expect(fast).toHaveAttribute('aria-checked', 'true');
});

it('switches the routing protocol timers to the IOS ones, leaving spanning tree alone', () => {
  const dialog = openFromPalette();
  const group = within(screen.getByRole('radiogroup', { name: 'Routing protocol timers' }));
  const fast = group.getByRole('radio', { name: 'Fast (default)' });
  const ios = group.getByRole('radio', { name: 'Real IOS (30 s updates)' });
  expect(fast).toHaveAttribute('aria-checked', 'true');
  expect(dialog).toHaveTextContent(
    'RIP sends updates every 5 s and drops a silent route after 15 s, so a lab converges in seconds.',
  );
  const { fast: ospfFast, ios: ospfIos } = OSPF_TIMERS;
  expect(dialog).toHaveTextContent(
    `OSPF says hello every ${ospfFast.hello} s and declares a silent neighbour dead after ${ospfFast.dead} s.`,
  );

  fireEvent.click(ios);

  expect(labSettings(editorStore.getState().topology)).toEqual({
    stpTimers: 'fast',
    routingTimers: 'ios',
  });
  expect(ios).toHaveAttribute('aria-checked', 'true');
  expect(dialog).toHaveTextContent(
    'RIP sends updates every 30 s; a silent route is invalid after 180 s, held down 180 s and flushed after 240 s, as on a real router.',
  );
  expect(dialog).toHaveTextContent(`OSPF hello ${ospfIos.hello} s, dead ${ospfIos.dead} s.`);
  act(() => editorStore.getState().undo());
  expect(fast).toHaveAttribute('aria-checked', 'true');
});

it('is found in the palette by rip, ospf or routing', () => {
  render(<LabSettingsDialog />);
  const command = commandRegistry.getCommands().find(({ title }) => title === 'Lab settings…');
  expect(command?.keywords).toEqual(expect.arrayContaining(['rip', 'ospf', 'routing']));
});
