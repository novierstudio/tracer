import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import type { AnnotationId, AnnotationSpec, DeviceId } from '@/model';
import { editorStore } from '@/model/store';
import type { DrawTool } from './annotations';

/** The one thing being typed into on the canvas, if any. A new note or text is not in the lab yet. */
type InlineEdit =
  | { kind: 'new'; annotation: AnnotationSpec }
  | { kind: 'annotation'; annotation: AnnotationId }
  | { kind: 'rename'; device: DeviceId };

type CanvasUiState = {
  edit: InlineEdit | null;
  /** The armed tool that drags out a box, until the box is drawn or Esc. */
  drawing: DrawTool | null;
};

// Canvas-only state: nothing outside the canvas reads what is being typed or drawn.
export const canvasUi = createStore<CanvasUiState>(() => ({ edit: null, drawing: null }));

export function useCanvasUi<T>(selector: (state: CanvasUiState) => T): T {
  return useStore(canvasUi, selector);
}

// An edit whose subject undo or a delete removed ends, as the store drops it from the selection.
editorStore.subscribe(({ topology }) => {
  const { edit } = canvasUi.getState();
  const gone =
    (edit?.kind === 'annotation' && !(edit.annotation in topology.annotations)) ||
    (edit?.kind === 'rename' && !(edit.device in topology.devices));
  if (gone) canvasUi.setState({ edit: null });
});
