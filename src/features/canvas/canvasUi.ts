import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import type { AnnotationId, DeviceId, Point } from '@/model';
import { editorStore } from '@/model/store';

/** The one thing being typed into on the canvas, if any. A new note is not in the lab yet. */
type InlineEdit =
  | { kind: 'new-note'; position: Point }
  | { kind: 'note'; note: AnnotationId }
  | { kind: 'rename'; device: DeviceId };

type CanvasUiState = {
  /** Selected notes. Devices and links keep their selection in the editor store. */
  notes: AnnotationId[];
  edit: InlineEdit | null;
};

// Canvas-only state: nothing outside the canvas reads which notes are selected or being edited.
export const canvasUi = createStore<CanvasUiState>(() => ({ notes: [], edit: null }));

export function useCanvasUi<T>(selector: (state: CanvasUiState) => T): T {
  return useStore(canvasUi, selector);
}

// Notes that undo or a delete removed drop out of the selection, as devices do in the store.
editorStore.subscribe(({ topology }) => {
  const { notes, edit } = canvasUi.getState();
  const kept = notes.filter((id) => id in topology.annotations);
  const editGone =
    (edit?.kind === 'note' && !(edit.note in topology.annotations)) ||
    (edit?.kind === 'rename' && !(edit.device in topology.devices));
  if (kept.length !== notes.length || editGone) {
    canvasUi.setState({ notes: kept, edit: editGone ? null : edit });
  }
});
