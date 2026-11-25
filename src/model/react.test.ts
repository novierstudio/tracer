import { act, renderHook } from '@testing-library/react';
import { expect, it } from 'vitest';
import { useEditor, useHistory } from './react';
import { editorStore } from './store';
import { buildLab } from './testing';

it('re-renders with the selected editor and history state', () => {
  const { topology, pc } = buildLab();
  editorStore.getState().load(topology);
  const { result } = renderHook(() => ({
    position: useEditor((state) => state.topology.devices[pc.id]?.position),
    canUndo: useHistory((history) => history.pastStates.length > 0),
  }));
  expect(result.current).toEqual({ position: pc.position, canUndo: false });

  act(() => editorStore.getState().moveDevices([{ device: pc.id, position: { x: 8, y: 9 } }]));

  expect(result.current).toEqual({ position: { x: 8, y: 9 }, canUndo: true });
});
