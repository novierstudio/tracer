import { temporal, type TemporalState } from 'zundo';
import { createStore, type StoreApi } from 'zustand/vanilla';
import * as commands from './commands';
import type {
  CableChange,
  CommandResult,
  ConfigUpdate,
  DeviceSpec,
  LinkSpec,
  Move,
} from './commands';
import { createIdSource, type DeviceId, type IdSource, type LinkId } from './ids';
import { ok, type Result } from './result';
import { emptyTopology, type Topology, type TopologyError } from './topology';
import type { Hostname } from './values';

export const HISTORY_LIMIT = 200;

export type Selection = { devices: DeviceId[]; links: LinkId[] };

export type EditorState = {
  topology: Topology;
  selection: Selection;
  addDevice(spec: DeviceSpec): Result<DeviceId, TopologyError>;
  removeDevices(ids: readonly DeviceId[]): void;
  moveDevices(moves: readonly Move[]): void;
  renameDevice(rename: { device: DeviceId; hostname: Hostname }): Result<void, TopologyError>;
  updateConfig(update: ConfigUpdate): Result<void, TopologyError>;
  setPowered(change: { device: DeviceId; powered: boolean }): Result<void, TopologyError>;
  addLink(spec: LinkSpec): Result<LinkId, TopologyError>;
  removeLinks(ids: readonly LinkId[]): void;
  setLinkCable(change: CableChange): Result<void, TopologyError>;
  renameLab(name: string): void;
  select(selection: Selection): void;
  beginGesture(): void;
  endGesture(): void;
  undo(): void;
  redo(): void;
  load(topology: Topology): void;
};

type History = Pick<EditorState, 'topology'>;

export type EditorHistory = TemporalState<History>;

export type EditorStore = StoreApi<EditorState> & { temporal: StoreApi<EditorHistory> };

const NOTHING_SELECTED: Selection = { devices: [], links: [] };

function pruneSelection(selection: Selection, topology: Topology): Selection {
  const devices = selection.devices.filter((id) => id in topology.devices);
  const links = selection.links.filter((id) => id in topology.links);
  const unchanged =
    devices.length === selection.devices.length && links.length === selection.links.length;
  return unchanged ? selection : { devices, links };
}

export function createEditorStore({
  topology = emptyTopology({ name: 'Untitled', now: new Date() }),
  ids = createIdSource(),
  now = () => new Date(),
}: { topology?: Topology; ids?: IdSource; now?: () => Date } = {}): EditorStore {
  let gestureStart: Topology | undefined;

  const store: EditorStore = createStore<EditorState>()(
    temporal(
      (set, get) => {
        const commit = (next: Topology) => {
          set({ topology: next, selection: pruneSelection(get().selection, next) });
        };
        const apply = (result: CommandResult): Result<void, TopologyError> => {
          if (!result.ok) return result;
          commit(result.value);
          return ok(undefined);
        };
        const endGesture = () => {
          const start = gestureStart;
          if (!start) return;
          gestureStart = undefined;
          const history = store.temporal.getState();
          history.resume();
          if (get().topology !== start) {
            store.temporal.setState({
              pastStates: [...history.pastStates, { topology: start }].slice(-HISTORY_LIMIT),
              futureStates: [],
            });
          }
        };
        const travel = (step: 'undo' | 'redo') => {
          endGesture();
          store.temporal.getState()[step]();
          commit(get().topology);
        };

        return {
          topology,
          selection: NOTHING_SELECTED,
          addDevice: (spec) => {
            const device = commands.createDevice(spec, { ids, topology: get().topology });
            const result = commands.addDevice(get().topology, device);
            if (!result.ok) return result;
            commit(result.value);
            return ok(device.id);
          },
          removeDevices: (deviceIds) => commit(commands.removeDevices(get().topology, deviceIds)),
          moveDevices: (moves) => commit(commands.moveDevices(get().topology, moves)),
          renameDevice: (rename) => apply(commands.renameDevice(get().topology, rename)),
          updateConfig: (update) => apply(commands.updateConfig(get().topology, update)),
          setPowered: (change) => apply(commands.setPowered(get().topology, change)),
          addLink: (spec) => {
            const link = commands.createLink(spec, { ids, topology: get().topology });
            const result = commands.addLink(get().topology, link);
            if (!result.ok) return result;
            commit(result.value);
            return ok(link.id);
          },
          removeLinks: (linkIds) => commit(commands.removeLinks(get().topology, linkIds)),
          setLinkCable: (change) => apply(commands.setLinkCable(get().topology, change)),
          renameLab: (name) => commit(commands.renameLab(get().topology, { name, now: now() })),
          select: (selection) => set({ selection: pruneSelection(selection, get().topology) }),
          beginGesture: () => {
            if (gestureStart) return;
            gestureStart = get().topology;
            store.temporal.getState().pause();
          },
          endGesture,
          undo: () => travel('undo'),
          redo: () => travel('redo'),
          load: (next) => {
            gestureStart = undefined;
            set({ topology: next, selection: NOTHING_SELECTED });
            store.temporal.getState().resume();
            store.temporal.getState().clear();
          },
        };
      },
      {
        partialize: (state): History => ({ topology: state.topology }),
        equality: (past, current) => past.topology === current.topology,
        limit: HISTORY_LIMIT,
      },
    ),
  );
  return store;
}

export const editorStore = createEditorStore();
