import { useStore } from 'zustand';
import { editorStore, type EditorHistory, type EditorState } from './store';

export function useEditor<T>(selector: (state: EditorState) => T): T {
  return useStore(editorStore, selector);
}

export function useHistory<T>(selector: (history: EditorHistory) => T): T {
  return useStore(editorStore.temporal, selector);
}
