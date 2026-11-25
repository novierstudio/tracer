// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest';
import { deviceSpec } from '@/devices/create';
import { emptyTopology, PortId, type AnnotationId, type DeviceId } from '@/model';
import { editorStore } from '@/model/store';
import { expectOk } from '@/model/testing';
import { canvasUi } from './canvasUi';
import {
  copySelection,
  deleteSelection,
  drawAnnotation,
  duplicateSelection,
  editText,
  finishEditing,
  nudge,
  paste,
  placeAnnotation,
  resizeAnnotation,
  selectAll,
  startRename,
  startTyping,
  toggleDrawTool,
} from './edit';

const editor = () => editorStore.getState();
const selection = () => editor().selection;
const select = (next: Parameters<ReturnType<typeof editor>['select']>[0]) => editor().select(next);
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
  const note = expectOk(
    editor().addAnnotation({
      kind: 'note',
      position: { x: 0, y: 96 },
      text: 'Core',
      width: 192,
      color: 'amber',
    }),
  );
  editorStore.temporal.getState().clear();
  return { router, sw, note };
}

beforeEach(() => {
  editor().load(emptyTopology({ name: 'Test', now: new Date(0) }));
  canvasUi.setState({ edit: null, drawing: null });
});

describe('canvas edits', () => {
  it('nudges selected devices and notes together, one grid step or four with Shift', () => {
    const { router, note } = cabledPair();
    select({ devices: [router], annotations: [note] });
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
    expect(selection()).toEqual({ devices: [], links: [], annotations: [] });
    editor().undo();
    expect(Object.keys(editor().topology.devices)).toHaveLength(2);
    expect(Object.keys(editor().topology.annotations)).toHaveLength(1);
  });

  it('pastes each copy one step further along and selects what it pasted', () => {
    const { router, sw } = cabledPair();
    select({ devices: [router, sw] });
    copySelection();
    paste();
    paste();
    const names = Object.values(editor().topology.devices).map((d) => d.config.hostname);
    expect(names).toEqual(['Router0', 'Switch0', 'Router1', 'Switch1', 'Router2', 'Switch2']);
    const [, , , , last] = Object.values(editor().topology.devices);
    expect(last!.position).toEqual({ x: 24 + 64, y: 64 });
    expect(selection().devices).toHaveLength(2);
    expect(selection().links).toHaveLength(1);
    expect(Object.keys(editor().topology.links)).toHaveLength(3);
    expect(steps()).toBe(2);
  });

  it('duplicates notes along with devices', () => {
    const { note } = cabledPair();
    select({ annotations: [note] });
    duplicateSelection();
    const texts = Object.values(editor().topology.annotations).map(
      (n) => n.kind === 'note' && n.text,
    );
    expect(texts).toEqual(['Core', 'Core']);
    expect(selection().annotations).toHaveLength(1);
    expect(selection().annotations).not.toContain(note);
  });

  it('adds a new note only once it has text', () => {
    startTyping('note', { x: 5, y: 9 });
    expect(finishEditing('   ')).toBeUndefined();
    expect(editor().topology.annotations).toEqual({});
    expect(steps()).toBe(0);

    startTyping('note', { x: 5, y: 9 });
    finishEditing('Rack 2\n');
    const [note] = Object.values(editor().topology.annotations);
    expect(note).toMatchObject({ kind: 'note', text: 'Rack 2', position: { x: 0, y: 16 } });
    expect(selection().annotations).toEqual([note!.id as AnnotationId]);
  });

  it('deletes a note whose text is cleared', () => {
    const { note } = cabledPair();
    editText(note);
    finishEditing('');
    expect(editor().topology.annotations).toEqual({});
  });

  it('adds text in the chosen size once it has words', () => {
    startTyping('text', { x: 40, y: 40 });
    finishEditing('Campus core');
    const [text] = Object.values(editor().topology.annotations);
    expect(text).toMatchObject({ kind: 'text', text: 'Campus core', textSize: 'medium' });
    expect(steps()).toBe(1);
  });

  it('draws an area box in one step, selects it and opens its label', () => {
    toggleDrawTool('area');
    expect(canvasUi.getState().drawing).toBe('area');
    const id = drawAnnotation('area', {
      position: { x: -37, y: -41 },
      size: { width: 301, height: 197 },
    })!;
    expect(editor().topology.annotations[id]).toEqual({
      id,
      kind: 'area',
      position: { x: -32, y: -48 },
      size: { width: 304, height: 192 },
      label: 'Area',
      color: 'blue',
    });
    expect(canvasUi.getState()).toEqual({
      drawing: null,
      edit: { kind: 'annotation', annotation: id },
    });
    expect(selection().annotations).toEqual([id]);

    finishEditing('  Building A ');
    expect(editor().topology.annotations[id]).toMatchObject({ label: 'Building A' });
    expect(steps()).toBe(2);
    editor().undo();
    expect(editor().topology.annotations[id]).toMatchObject({ label: 'Area' });
  });

  it('keeps an area whose label is cleared', () => {
    const id = placeAnnotation('area', { x: 0, y: 0 })!;
    finishEditing('');
    expect(editor().topology.annotations[id]).toMatchObject({ kind: 'area', label: '' });
  });

  it('places a default ellipse centred on a click', () => {
    const id = placeAnnotation('ellipse', { x: 200, y: 100 })!;
    expect(editor().topology.annotations[id]).toMatchObject({
      kind: 'shape',
      shape: 'ellipse',
      position: { x: 128, y: 48 },
      size: { width: 160, height: 96 },
    });
    expect(canvasUi.getState().edit).toBeNull();
  });

  it('resizes as one undo step when a gesture brackets the drag', () => {
    const id = placeAnnotation('rectangle', { x: 0, y: 0 })!;
    const before = steps();
    editor().beginGesture();
    resizeAnnotation(id, { position: { x: -96, y: -48 }, width: 176, height: 96 });
    resizeAnnotation(id, { position: { x: -112, y: -48 }, width: 192, height: 112 });
    editor().endGesture();
    expect(editor().topology.annotations[id]).toMatchObject({
      position: { x: -112, y: -48 },
      size: { width: 192, height: 112 },
    });
    expect(steps()).toBe(before + 1);
  });

  it('moves devices out from under an area box without moving the box', () => {
    const { router } = cabledPair();
    const area = placeAnnotation('area', { x: 100, y: 0 })!;
    const box = editor().topology.annotations[area]!.position;
    editor().moveDevices([{ device: router, position: { x: 136, y: 40 } }]);
    expect(editor().topology.annotations[area]!.position).toEqual(box);
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
