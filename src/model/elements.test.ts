// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { addElements, createLink, type AnnotationSpec } from './commands';
import { AnnotationId, createIdSource, DeviceId } from './ids';
import { createEditorStore } from './store';
import { buildLab, end, expectOk } from './testing';
import { Topology, type Annotation } from './topology';

function labStore() {
  const lab = buildLab();
  return { ...lab, store: createEditorStore({ topology: lab.topology, ids: createIdSource(9) }) };
}

const NOTE = { kind: 'note', position: { x: 16, y: 32 }, text: 'Building A' } as const;

/** One of each kind, as the canvas tools create them. */
const SPECS: AnnotationSpec[] = [
  { ...NOTE, width: 192, color: 'amber' },
  { kind: 'text', position: { x: 0, y: 0 }, text: 'Core', textSize: 'large', color: 'slate' },
  {
    kind: 'area',
    position: { x: -32, y: -32 },
    size: { width: 320, height: 224 },
    label: 'Building A',
    color: 'blue',
  },
  {
    kind: 'shape',
    shape: 'ellipse',
    position: { x: 400, y: 0 },
    size: { width: 160, height: 96 },
    color: 'red',
  },
];

describe('annotations', () => {
  it.each(SPECS)('adds, edits, moves and removes a $kind, one undo step each', (spec) => {
    const { store, topology } = labStore();
    const editor = () => store.getState();

    const id = expectOk(editor().addAnnotation(spec));
    const added = editor().topology.annotations[id];
    expect(added).toEqual({ ...spec, id });
    expect(Topology.safeParse(editor().topology).success).toBe(true);

    expectOk(editor().updateAnnotation({ ...added!, color: 'green' }));
    editor().moveAnnotations([{ annotation: id, position: { x: 64, y: 64 } }]);
    expect(editor().topology.annotations[id]).toMatchObject({
      color: 'green',
      position: { x: 64, y: 64 },
    });
    editor().removeAnnotations([id]);
    expect(editor().topology.annotations).toEqual({});

    editor().undo();
    expect(editor().topology.annotations[id]?.position).toEqual({ x: 64, y: 64 });
    editor().undo();
    expect(editor().topology.annotations[id]?.position).toEqual(spec.position);
    expect(editor().topology.annotations[id]?.color).toBe('green');
    editor().undo();
    expect(editor().topology.annotations[id]).toEqual({ ...spec, id });
    editor().undo();
    expect(editor().topology).toBe(topology);
  });

  it('resizes an area from its top-left corner in one step', () => {
    const { store } = labStore();
    const area = SPECS[2]!;
    const id = expectOk(store.getState().addAnnotation(area));
    const before = store.temporal.getState().pastStates.length;
    const current = store.getState().topology.annotations[id];
    if (current?.kind !== 'area') throw new Error('Expected an area');

    expectOk(
      store.getState().updateAnnotation({
        ...current,
        position: { x: -64, y: -48 },
        size: { width: 352, height: 240 },
      }),
    );

    expect(store.getState().topology.annotations[id]).toMatchObject({
      position: { x: -64, y: -48 },
      size: { width: 352, height: 240 },
      label: 'Building A',
    });
    expect(store.temporal.getState().pastStates).toHaveLength(before + 1);
  });

  it('refuses to update an annotation that does not exist, and leaves history alone', () => {
    const { store } = labStore();
    const missing = AnnotationId.parse('ann_missing');
    const result = store.getState().updateAnnotation({ ...SPECS[0]!, id: missing });
    expect(result).toEqual({
      ok: false,
      error: { kind: 'annotation-not-found', annotation: missing },
    });
    expect(store.temporal.getState().pastStates).toHaveLength(0);
  });

  it('records no step when nothing changes', () => {
    const { store } = labStore();
    const id = expectOk(store.getState().addAnnotation(SPECS[1]!));
    const before = store.temporal.getState().pastStates.length;
    const same = structuredClone(store.getState().topology.annotations[id]!);
    expectOk(store.getState().updateAnnotation(same));
    expect(store.temporal.getState().pastStates).toHaveLength(before);
  });

  it('drops removed annotations from the selection, and brings neither back on undo', () => {
    const { store } = labStore();
    const id = expectOk(store.getState().addAnnotation(SPECS[2]!));
    store.getState().select({ annotations: [id] });
    expect(store.getState().selection).toEqual({ devices: [], links: [], annotations: [id] });

    store.getState().removeAnnotations([id]);
    expect(store.getState().selection.annotations).toEqual([]);
    store.getState().undo();
    expect(store.getState().selection.annotations).toEqual([]);
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
    const note: Annotation = {
      id: AnnotationId.parse('ann_note1'),
      kind: 'note',
      width: 192,
      color: 'amber',
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
