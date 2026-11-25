import { createStore } from 'zustand/vanilla';
import { emptyTopology, parseTopology, serializeTopology, type Topology } from '@/model';
import { editorStore, type EditorStore } from '@/model/store';
import { createAutosave, type SaveStatus } from './autosave';
import * as browserIo from './fileAccess';
import { importFile } from './importers';
import {
  newLabId,
  openLabStorage,
  type LabId,
  type LabStorage,
  type LabSummary,
} from './labStorage';

export const RECENT_LIMIT = 5;
export const DEFAULT_LAB_NAME = 'Untitled lab';

export type FileProblem = { title: string; message: string };

export type FilesState = {
  status: SaveStatus;
  // Other labs, most recently used first. The open lab is left out.
  recents: LabSummary[];
  // Non-blocking, such as a last lab that could not be restored.
  notice: string | undefined;
  // Blocking, such as a file that failed validation.
  problem: FileProblem | undefined;
  confirmingNew: boolean;
};

type FileIo = Pick<
  typeof browserIo,
  'pickSaveHandle' | 'writeToHandle' | 'download' | 'pickOpenFile'
>;

type FileSessionOptions = {
  store: EditorStore;
  openStorage: () => Promise<LabStorage>;
  io?: FileIo;
  delayMs?: number;
  now?: () => Date;
};

export type FileSession = ReturnType<typeof createFileSession>;

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function createFileSession({
  store,
  openStorage,
  io = browserIo,
  delayMs,
  now = () => new Date(),
}: FileSessionOptions) {
  const state = createStore<FilesState>()(() => ({
    status: 'saved',
    recents: [],
    notice: undefined,
    problem: undefined,
    confirmingNew: false,
  }));

  let storage: Promise<LabStorage> | undefined;
  const getStorage = () => (storage ??= openStorage());

  let labId = newLabId();
  // The file Save writes back to, when the browser can write files in place.
  let handle: FileSystemFileHandle | undefined;
  // The topology as last loaded, opened or saved to a file. Anything else is an unsaved change.
  let baseline = store.getState().topology;
  // True while this session replaces the topology itself, so the change is not autosaved.
  let loading = false;
  let restoring: Promise<void> | undefined;

  const refreshRecents = async () => {
    try {
      const recent = await (await getStorage()).recent(RECENT_LIMIT + 1);
      const recents = recent.filter((lab) => lab.id !== labId).slice(0, RECENT_LIMIT);
      state.setState({ recents });
    } catch {
      // The status already says storage is unavailable.
    }
  };

  const autosave = createAutosave({
    storage: getStorage,
    delayMs,
    now,
    onStatus: (status) => state.setState({ status }),
    onWrite: () => void refreshRecents(),
  });

  const replaceTopology = (topology: Topology) => {
    loading = true;
    try {
      store.getState().load(topology);
    } finally {
      loading = false;
    }
    baseline = topology;
  };

  const emptyLab = () => emptyTopology({ name: DEFAULT_LAB_NAME, now: now() });

  // Opened labs are written at once so a reload restores them. A new empty lab is only pointed at:
  // it joins the recent list once it has a change.
  const switchTo = async (
    id: LabId,
    topology: Topology,
    { persist, file }: { persist: boolean; file?: FileSystemFileHandle },
  ) => {
    await autosave.flush();
    labId = id;
    handle = file;
    replaceTopology(topology);
    if (persist) {
      autosave.schedule(id, topology);
      await autosave.flush();
    } else {
      try {
        await (await getStorage()).setCurrent(id);
      } catch {
        state.setState({ status: 'unavailable' });
      }
    }
    await refreshRecents();
  };

  const restore = async () => {
    const initial = store.getState().topology;
    const untouched = () => store.getState().topology === initial;
    try {
      const db = await getStorage();
      const id = await db.getCurrentId();
      const record = id && (await db.get(id));
      if (!untouched()) return;
      if (!id || !record) {
        if (id) labId = id;
        replaceTopology(emptyLab());
        return;
      }
      const parsed = parseTopology(record.topology);
      if (!parsed.ok) {
        // Keep the stored copy (a newer build may read it) and start fresh under a new id.
        replaceTopology(emptyLab());
        state.setState({
          notice: `“${record.name}” could not be restored, so this is a new lab. ${parsed.error.message}`,
        });
        return;
      }
      labId = id;
      replaceTopology(parsed.value);
    } catch {
      state.setState({ status: 'unavailable' });
    } finally {
      await refreshRecents();
    }
  };

  const openFile = async (file: File, fileHandle?: FileSystemFileHandle) => {
    const result = await importFile(file);
    if (!result.ok) {
      state.setState({ problem: { title: `Couldn't open ${file.name}`, message: result.error } });
      return;
    }
    // Only a native file can be saved back in place; an imported format keeps its original.
    const writable = file.name.toLowerCase().endsWith(browserIo.NATIVE_EXTENSION);
    await switchTo(newLabId(), result.value, {
      persist: true,
      file: writable ? fileHandle : undefined,
    });
  };

  const saveAs = async () => {
    const topology = store.getState().topology;
    const text = serializeTopology(topology);
    const name = browserIo.fileNameFor(topology.meta.name);
    try {
      const picked = await io.pickSaveHandle(name);
      if (picked) {
        await io.writeToHandle(picked, text);
        handle = picked;
      } else {
        io.download(text, name);
      }
      baseline = topology;
    } catch (error) {
      if (browserIo.isAbort(error)) return;
      state.setState({ problem: { title: "Couldn't save the lab", message: describe(error) } });
    }
  };

  const hasUnsavedChanges = () => store.getState().topology !== baseline;

  const createNewLab = () => switchTo(newLabId(), emptyLab(), { persist: false });

  return {
    state,

    // Restores the last lab once, then autosaves every change. Returns a stop function.
    start() {
      const unsubscribe = store.subscribe((next, prev) => {
        if (next.topology !== prev.topology && !loading) autosave.schedule(labId, next.topology);
      });
      const flushNow = () => void autosave.flush();
      const flushIfHidden = () => document.visibilityState === 'hidden' && flushNow();
      window.addEventListener('pagehide', flushNow);
      document.addEventListener('visibilitychange', flushIfHidden);
      restoring ??= restore();
      return () => {
        unsubscribe();
        window.removeEventListener('pagehide', flushNow);
        document.removeEventListener('visibilitychange', flushIfHidden);
        flushNow();
      };
    },
    restored: () => restoring ?? Promise.resolve(),
    flush: () => autosave.flush(),

    hasUnsavedChanges,

    newLab() {
      if (!hasUnsavedChanges()) return createNewLab();
      state.setState({ confirmingNew: true });
    },
    confirmNewLab() {
      state.setState({ confirmingNew: false });
      return createNewLab();
    },
    cancelNewLab: () => state.setState({ confirmingNew: false }),

    async open() {
      try {
        const picked = await io.pickOpenFile();
        if (picked) await openFile(picked.file, picked.handle);
      } catch (error) {
        state.setState({ problem: { title: "Couldn't open the file", message: describe(error) } });
      }
    },
    openFile,
    async openRecent(lab: LabSummary) {
      try {
        const record = await (await getStorage()).get(lab.id);
        const parsed = record ? parseTopology(record.topology) : undefined;
        if (!parsed?.ok) {
          const message = parsed ? parsed.error.message : 'It is no longer in this browser.';
          state.setState({ problem: { title: `Couldn't open “${lab.name}”`, message } });
          return;
        }
        await switchTo(lab.id, parsed.value, { persist: true });
      } catch (error) {
        state.setState({
          problem: { title: `Couldn't open “${lab.name}”`, message: describe(error) },
        });
      }
    },

    async save() {
      if (!handle) return saveAs();
      const topology = store.getState().topology;
      try {
        await io.writeToHandle(handle, serializeTopology(topology));
        baseline = topology;
      } catch (error) {
        if (browserIo.isAbort(error)) return;
        state.setState({ problem: { title: "Couldn't save the lab", message: describe(error) } });
      }
    },
    saveAs,

    // The model has no lab-rename command yet. `setState` still goes through undo history.
    rename(name: string) {
      const trimmed = name.trim() || DEFAULT_LAB_NAME;
      const { topology } = store.getState();
      if (trimmed === topology.meta.name) return;
      store.setState({
        topology: {
          ...topology,
          meta: { ...topology.meta, name: trimmed, updatedAt: now().toISOString() },
        },
      });
    },

    dismissNotice: () => state.setState({ notice: undefined }),
    dismissProblem: () => state.setState({ problem: undefined }),
  };
}

export const fileSession = createFileSession({ store: editorStore, openStorage: openLabStorage });
