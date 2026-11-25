// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest';
import { deviceSpec } from '@/devices/create';
import { emptyTopology, PortId, type AnnotationId, type DeviceId } from '@/model';
import { editorStore } from '@/model/store';
import { expectOk } from '@/model/testing';
import { canvasUi } from './canvasUi';
import {
  copySelection,
  currentSelection,
  deleteSelection,
  duplicateSelection,
  finishEditing,
  nudge,
  paste,
  selectAll,
  setSelection,
  startNote,
  startRename,
} from './edit';

const editor = () => editorStore.getState();
const steps = () => editorStore.temporal.getState().pastStates.length;

function cabledPair() {
  const add = (model: 'router-2g2s' | 'switch-24', x: number) =>
    expectOk(
      editor().addDevice(
        deviceSpec(model, {
          position: { x, y: 0 },
          existingNames: Object.values(editor().topology.devices).map((d) => d.config.hostname),
        }),
      ),
    );
  const router = add('router-2g2s', 24);
  const sw = add('switch-24', 216);
  expectOk(
    editor().addLink({
      cable: 'straight',
      a: { device: router, port: PortId.parse('GigabitEthernet0/0') },
      b: { device: sw, port: PortId.parse('FastEthernet0/1') },
    }),
  );
  const note = expectOk(editor().addNote({ position: { x: 0, y: 96 }, text: 'Core' }));
  editorStore.temporal.getState().clear();
  return { router, sw, note };
}

beforeEach(() => {
  editor().load(emptyTopology({ name: 'Test', now: new Date(0) }));
  canvasUi.setState({ notes: [], edit: null });
});

describe('canvas edits', () => {
  it('nudges selected devices and notes together, one grid step or four with Shift', () => {
    const { router, note } = cabledPair();
    setSelection({ devices: [router], links: [], notes: [note] });
    nudge({ key: 'ArrowRight', shiftKey: false });
    nudge({ key: 'ArrowUp', shiftKey: true });
    expect(editor().topology.devices[router]!.position).toEqual({ x: 40, y: -64 });
    expect(editor().topology.annotations[note]!.position).toEqual({ x: 16, y: 32 });
    expect(steps()).toBe(2);
  });

  it('deletes devices, links and notes in one undo step', () => {
    cabledPair();
    selectAll();
    deleteSelection();
    expect(editor().topology).toMatchObject({ devices: {}, links: {}, annotations: {} });
    expect(currentSelection()).toEqual({ devices: [], links: [], notes: [] });
    editor().undo();
    expect(Object.keys(editor().topology.devices)).toHaveLength(2);
    expect(Object.keys(editor().topology.annotations)).toHaveLength(1);
  });

  it('pastes each copy one step further along and selects what it pasted', () => {
    const { router, sw } = cabledPair();
    setSelection({ devices: [router, sw], links: [], notes: [] });
    copySelection();
    paste();
    paste();
    const names = Object.values(editor().topology.devices).map((d) => d.config.hostname);
    expect(names).toEqual(['Router0', 'Switch0', 'Router1', 'Switch1', 'Router2', 'Switch2']);
    const [, , , , last] = Object.values(editor().topology.devices);
    expect(last!.position).toEqual({ x: 24 + 64, y: 64 });
    expect(currentSelection().devices).toHaveLength(2);
    expect(currentSelection().links).toHaveLength(1);
    expect(Object.keys(editor().topology.links)).toHaveLength(3);
    expect(steps()).toBe(2);
  });

  it('duplicates notes along with devices', () => {
    const { note } = cabledPair();
    setSelection({ devices: [], links: [], notes: [note] });
    duplicateSelection();
    const texts = Object.values(editor().topology.annotations).map((n) => n.text);
    expect(texts).toEqual(['Core', 'Core']);
    expect(currentSelection().notes).not.toContain(note);
  });

  it('adds a new note only once it has text', () => {
    startNote({ x: 5, y: 9 });
    expect(finishEditing('   ')).toBeUndefined();
    expect(editor().topology.annotations).toEqual({});
    expect(steps()).toBe(0);

    startNote({ x: 5, y: 9 });
    finishEditing('Rack 2\n');
    const [note] = Object.values(editor().topology.annotations);
    expect(note).toMatchObject({ text: 'Rack 2', position: { x: 0, y: 16 } });
    expect(currentSelection().notes).toEqual([note!.id as AnnotationId]);
  });

  it('deletes a note whose text is cleared', () => {
    const { note } = cabledPair();
    canvasUi.setState({ edit: { kind: 'note', note } });
    finishEditing('');
    expect(editor().topology.annotations).toEqual({});
  });

  it('renames a device inline, and explains a name it cannot take', () => {
    const { router } = cabledPair();
    startRename(router as DeviceId);
    expect(finishEditing('9lives')).toMatch(/must start with a letter/);
    expect(editor().topology.devices[router]!.config.hostname).toBe('Router0');
    startRename(router);
    expect(finishEditing('Edge-1')).toBeUndefined();
    expect(editor().topology.devices[router]!.config.hostname).toBe('Edge-1');
  });
});
