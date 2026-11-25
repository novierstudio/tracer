// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { addElements, createLink } from './commands';
import { AnnotationId, createIdSource, DeviceId } from './ids';
import { createEditorStore } from './store';
import { buildLab, end, expectOk } from './testing';
import { Topology } from './topology';

function labStore() {
  const lab = buildLab();
  return { ...lab, store: createEditorStore({ topology: lab.topology, ids: createIdSource(9) }) };
}

describe('notes', () => {
  it('adds, edits, moves and removes a note, one undo step each', () => {
    const { store, topology } = labStore();
    const editor = () => store.getState();

    const id = expectOk(editor().addNote({ position: { x: 16, y: 32 }, text: 'Building A' }));
    expect(editor().topology.annotations[id]).toEqual({
      id,
      kind: 'note',
      position: { x: 16, y: 32 },
      text: 'Building A',
    });
    expectOk(editor().editNote({ annotation: id, text: 'Building B' }));
    editor().moveAnnotations([{ annotation: id, position: { x: 64, y: 64 } }]);
    expect(editor().topology.annotations[id]).toMatchObject({
      text: 'Building B',
      position: { x: 64, y: 64 },
    });
    editor().removeAnnotations([id]);
    expect(editor().topology.annotations).toEqual({});
    expect(Topology.safeParse(editor().topology).success).toBe(true);

    editor().undo();
    expect(editor().topology.annotations[id]?.position).toEqual({ x: 64, y: 64 });
    editor().undo();
    expect(editor().topology.annotations[id]?.position).toEqual({ x: 16, y: 32 });
    editor().undo();
    expect(editor().topology.annotations[id]?.text).toBe('Building A');
    editor().undo();
    expect(editor().topology).toBe(topology);
  });

  it('refuses to edit a note that does not exist, and leaves history alone', () => {
    const { store } = labStore();
    const missing = AnnotationId.parse('ann_missing');
    expect(store.getState().editNote({ annotation: missing, text: 'x' })).toEqual({
      ok: false,
      error: { kind: 'annotation-not-found', annotation: missing },
    });
    expect(store.temporal.getState().pastStates).toHaveLength(0);
  });

  it('records no step when the text is unchanged', () => {
    const { store } = labStore();
    const id = expectOk(store.getState().addNote({ position: { x: 0, y: 0 }, text: 'Same' }));
    const before = store.temporal.getState().pastStates.length;
    expectOk(store.getState().editNote({ annotation: id, text: 'Same' }));
    expect(store.temporal.getState().pastStates).toHaveLength(before);
  });
});

describe('addElements', () => {
  it('adds devices, the links between them and notes as one undo step', () => {
    const { store, topology, r1, sw, ids } = labStore();
    const copyR1 = { ...r1, id: DeviceId.parse('dev_copyR1') };
    const copySw = { ...sw, id: DeviceId.parse('dev_copySW') };
    const link = createLink(
      {
        cable: 'straight',
        a: end(copyR1, 'GigabitEthernet0/0'),
        b: end(copySw, 'FastEthernet0/1'),
      },
      { ids, topology },
    );
    const note = {
      id: AnnotationId.parse('ann_note1'),
      kind: 'note' as const,
      position: { x: 0, y: 0 },
      text: 'Copied',
    };

    expectOk(
      store
        .getState()
        .addElements({ devices: [copyR1, copySw], links: [link], annotations: [note] }),
    );
    const next = store.getState().topology;
    expect(Object.keys(next.devices)).toHaveLength(Object.keys(topology.devices).length + 2);
    expect(next.links[link.id]).toEqual(link);
    expect(next.annotations[note.id]).toEqual(note);

    store.getState().undo();
    expect(store.getState().topology).toBe(topology);
  });

  it('adds nothing when one element is refused', () => {
    const { topology, r1, sw, ids } = buildLab();
    const copy = { ...r1, id: DeviceId.parse('dev_copy') };
    const dangling = createLink(
      { cable: 'straight', a: end(copy, 'GigabitEthernet0/0'), b: end(sw, 'FastEthernet0/9') },
      { ids, topology },
    );
    const result = addElements(topology, { devices: [copy], links: [dangling] });
    expect(result).toEqual({
      ok: false,
      error: { kind: 'port-not-found', endpoint: end(sw, 'FastEthernet0/9') },
    });
  });

  it('refuses a device id already in the lab', () => {
    const { topology, r1 } = buildLab();
    expect(addElements(topology, { devices: [r1] })).toEqual({
      ok: false,
      error: { kind: 'duplicate-id', id: r1.id },
    });
  });
});
