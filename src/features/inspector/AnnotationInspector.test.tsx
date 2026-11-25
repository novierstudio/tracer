import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it } from 'vitest';
import { emptyTopology, type AnnotationId } from '@/model';
import { editorStore } from '@/model/store';
import { expectOk } from '@/model/testing';
import { TooltipProvider } from '@/ui/tooltip';
import { InspectorPanel } from './InspectorPanel';

const editor = () => editorStore.getState();
const steps = () => editorStore.temporal.getState().pastStates.length;
let area: AnnotationId;

beforeEach(() => {
  act(() => editor().load(emptyTopology({ name: 'Test', now: new Date(0) })));
  area = expectOk(
    editor().addAnnotation({
      kind: 'area',
      position: { x: 0, y: 0 },
      size: { width: 320, height: 192 },
      label: 'Area',
      color: 'blue',
    }),
  );
  editorStore.temporal.getState().clear();
  render(
    <TooltipProvider>
      <InspectorPanel />
    </TooltipProvider>,
  );
});

it('shows a selected area box and edits its label, colour and size, one undo step each', () => {
  act(() => editor().select({ annotations: [area] }));
  expect(screen.getByRole('heading', { name: 'Area box' })).toBeInTheDocument();

  const label = screen.getByRole('textbox', { name: 'Label' });
  fireEvent.change(label, { target: { value: 'Building A' } });
  fireEvent.keyDown(label, { key: 'Enter' });
  fireEvent.click(screen.getByRole('radio', { name: 'Teal' }));
  const width = screen.getByRole('textbox', { name: 'Width' });
  fireEvent.change(width, { target: { value: '400' } });
  fireEvent.blur(width);

  expect(editor().topology.annotations[area]).toMatchObject({
    label: 'Building A',
    color: 'teal',
    size: { width: 400, height: 192 },
  });
  expect(screen.getByRole('radio', { name: 'Teal' })).toHaveAttribute('aria-checked', 'true');
  expect(steps()).toBe(3);
  act(() => editor().undo());
  expect(editor().topology.annotations[area]).toMatchObject({
    color: 'teal',
    size: { width: 320 },
  });
});

it('deletes the annotation from its panel, and the panel empties', () => {
  act(() => editor().select({ annotations: [area] }));
  fireEvent.click(screen.getByRole('button', { name: 'Delete area box' }));
  expect(editor().topology.annotations).toEqual({});
  expect(screen.getByText('Nothing selected')).toBeInTheDocument();
});
