import { useStore } from 'zustand';
import { fileSession, type FilesState } from './session';

export function useFiles<T>(selector: (state: FilesState) => T): T {
  return useStore(fileSession.state, selector);
}
