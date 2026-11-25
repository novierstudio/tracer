import { act, fireEvent, render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { editorStore } from '@/model/store';
import { buildLab } from '@/model/testing';
import { TooltipProvider } from '@/ui/tooltip';
import { HistoryButtons } from './TopBar';

it('enables undo after an edit and steps the topology back and forward', () => {
  const { topology, pc } = buildLab();
  act(() => {
    editorStore.getState().load(topology);
    editorStore.temporal.getState().clear();
  });
  render(
    <TooltipProvider>
      <HistoryButtons />
    </TooltipProvider>,
  );
  const undo = screen.getByRole('button', { name: 'Undo' });
  const redo = screen.getByRole('button', { name: 'Redo' });
  expect(undo).toBeDisabled();
  expect(redo).toBeDisabled();

  act(() => editorStore.getState().moveDevices([{ device: pc.id, position: { x: 8, y: 9 } }]));
  expect(undo).toBeEnabled();

  fireEvent.click(undo);
  expect(editorStore.getState().topology.devices[pc.id]?.position).toEqual(pc.position);
  expect(redo).toBeEnabled();

  fireEvent.click(redo);
  expect(editorStore.getState().topology.devices[pc.id]?.position).toEqual({ x: 8, y: 9 });
});
