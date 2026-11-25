import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import type { DeviceId, Endpoint, PortId } from '@/model';
import { editorStore, type EditorStore } from '@/model/store';
import { describeCableError, onlyPort, planLink, requiredMedium, type CableChoice } from './cables';

/** Where a cable in progress is. A null step means the select tool is active. */
export type CableStep =
  | { at: 'source' }
  | { at: 'source-port'; device: DeviceId }
  | { at: 'target'; source: Endpoint }
  | { at: 'target-port'; source: Endpoint; device: DeviceId };

type Notice = { id: number; message: string };

export type CableToolState = {
  cable: CableChoice;
  step: CableStep | null;
  notice: Notice | null;
  toggle(): void;
  exit(): void;
  chooseCable(cable: CableChoice): void;
  clickDevice(device: DeviceId): void;
  choosePort(port: PortId): void;
  /** Closes the port picker without choosing, keeping any source already picked. */
  dismissPicker(): void;
  /** Esc: drops the cable in progress, or leaves the tool. False when there was nothing to do. */
  escape(): boolean;
  clearNotice(id: number): void;
};

let noticeId = 0;

export function createCableTool(editor: EditorStore) {
  return createStore<CableToolState>()((set, get) => {
    const notify = (message: string) => set({ notice: { id: ++noticeId, message } });

    const connect = (source: Endpoint, target: Endpoint) => {
      const { topology, addLink, select } = editor.getState();
      const plan = planLink(topology, get().cable, source, target);
      const result = plan.ok ? addLink(plan.value) : plan;
      if (!result.ok) {
        notify(describeCableError(topology, result.error));
        set({ step: { at: 'target', source } });
        return;
      }
      select({ devices: [], links: [result.value] });
      set({ step: { at: 'source' } });
    };

    return {
      cable: 'auto',
      step: null,
      notice: null,
      toggle: () => set({ step: get().step ? null : { at: 'source' } }),
      exit: () => set({ step: null }),
      chooseCable: (cable) => set({ cable, step: get().step ?? { at: 'source' } }),
      clickDevice: (device) => {
        const { step } = get();
        if (!step) return;
        const { topology } = editor.getState();
        if (step.at === 'source' || step.at === 'source-port') {
          const port = onlyPort(topology, device, requiredMedium(topology, get().cable));
          set({
            step: port ? { at: 'target', source: { device, port } } : { at: 'source-port', device },
          });
          return;
        }
        if (device === step.source.device) {
          notify(describeCableError(topology, { kind: 'same-device', device }));
          return;
        }
        const port = onlyPort(topology, device, requiredMedium(topology, get().cable, step.source));
        if (port) connect(step.source, { device, port });
        else set({ step: { at: 'target-port', source: step.source, device } });
      },
      choosePort: (port) => {
        const { step } = get();
        if (step?.at === 'source-port') {
          set({ step: { at: 'target', source: { device: step.device, port } } });
        } else if (step?.at === 'target-port') {
          connect(step.source, { device: step.device, port });
        }
      },
      dismissPicker: () => {
        const { step } = get();
        if (step?.at === 'source-port') set({ step: { at: 'source' } });
        else if (step?.at === 'target-port') set({ step: { at: 'target', source: step.source } });
      },
      escape: () => {
        const { step } = get();
        if (!step) return false;
        set({ step: step.at === 'source' ? null : { at: 'source' } });
        return true;
      },
      clearNotice: (id) => {
        if (get().notice?.id === id) set({ notice: null });
      },
    };
  });
}

export const cableTool = createCableTool(editorStore);

export function useCableTool<T>(selector: (state: CableToolState) => T): T {
  return useStore(cableTool, selector);
}
