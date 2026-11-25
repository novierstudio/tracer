import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serializeTopology, type Topology } from '@/model';
import { createEditorStore } from '@/model/store';
import { buildLab } from '@/model/testing';
import { newLabId, openLabStorage } from './labStorage';
import { createFileSession, DEFAULT_LAB_NAME, RECENT_LIMIT, type FileSession } from './session';

const named = (topology: Topology, name: string) => ({
  ...topology,
  meta: { ...topology.meta, name },
});

let stops: (() => void)[] = [];

function startSession(io: Partial<Parameters<typeof createFileSession>[0]['io']> = {}) {
  const store = createEditorStore();
  let clock = Date.parse('2026-11-25T10:00:00.000Z');
  const downloads: { text: string; name: string }[] = [];
  const session = createFileSession({
    store,
    openStorage: openLabStorage,
    delayMs: 10,
    now: () => new Date((clock += 1000)),
    io: {
      pickSaveHandle: async () => undefined,
      writeToHandle: async () => {},
      download: (text, name) => void downloads.push({ text, name }),
      pickOpenFile: async () => undefined,
      ...io,
    },
  });
  stops.push(session.start());
  const edit = (topology: Topology) => store.getState().load(topology);
  return { store, session, downloads, edit, topology: () => store.getState().topology };
}

async function openLab(session: FileSession, topology: Topology) {
  await session.openFile(
    new File([serializeTopology(topology)], `${topology.meta.name}.tracer.json`),
  );
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});

afterEach(() => {
  stops.forEach((stop) => stop());
  stops = [];
});

describe('restore', () => {
  it('brings back the last lab after a restart', async () => {
    const first = startSession();
    await first.session.restored();
    const lab = named(buildLab().topology, 'Campus');
    first.edit(lab);
    await first.session.flush();

    const second = startSession();
    await second.session.restored();
    expect(second.topology()).toEqual(lab);
    expect(second.session.hasUnsavedChanges()).toBe(false);
  });

  it('autosaves after the debounce without an explicit flush', async () => {
    const first = startSession();
    await first.session.restored();
    first.edit(named(buildLab().topology, 'Debounced'));
    expect(first.session.state.getState().status).toBe('saving');
    await vi.waitFor(() => expect(first.session.state.getState().status).toBe('saved'));

    const second = startSession();
    await second.session.restored();
    expect(second.topology().meta.name).toBe('Debounced');
  });

  it.each([
    ['a newer version', { version: 99, anything: true }],
    ['an invalid topology', { version: 1, meta: 'nope' }],
  ])('falls back to an empty lab with a notice when the record is %s', async (_, document) => {
    const db = await openLabStorage();
    const id = newLabId();
    const broken = {
      id,
      name: 'Broken',
      updatedAt: new Date().toISOString(),
      deviceCount: 0,
      topology: document,
    };
    await db.put(broken);

    const { session, topology, edit } = startSession();
    await session.restored();
    expect(topology().devices).toEqual({});
    expect(topology().meta.name).toBe(DEFAULT_LAB_NAME);
    expect(session.state.getState().notice).toContain('Broken');

    // Editing the fresh lab must not overwrite the record a newer build might still read.
    edit(named(buildLab().topology, 'Fresh'));
    await session.flush();
    expect(await db.get(id)).toEqual(broken);
  });

  it('keeps working without storage and says so', async () => {
    const store = createEditorStore();
    const session = createFileSession({
      store,
      openStorage: () => Promise.reject(new DOMException('blocked', 'InvalidStateError')),
    });
    stops.push(session.start());
    await session.restored();
    store.getState().load(buildLab().topology);
    await session.flush();
    expect(session.state.getState().status).toBe('unavailable');
    expect(Object.keys(store.getState().topology.devices)).toHaveLength(5);
  });
});

describe('save and open', () => {
  it('saves a file that opens to the identical topology', async () => {
    const saver = startSession();
    await saver.session.restored();
    const lab = named(buildLab().topology, 'Branch / office');
    saver.edit(lab);
    expect(saver.session.hasUnsavedChanges()).toBe(true);

    await saver.session.save();
    expect(saver.downloads.map((d) => d.name)).toEqual(['Branch - office.tracer.json']);
    expect(saver.session.hasUnsavedChanges()).toBe(false);

    const opener = startSession();
    await opener.session.restored();
    const [saved] = saver.downloads;
    await opener.session.openFile(new File([saved!.text], saved!.name));
    expect(opener.topology()).toEqual(lab);
  });

  it('saves back to the same file once it has one', async () => {
    const handle = { name: 'lab.tracer.json' } as FileSystemFileHandle;
    const pickSaveHandle = vi.fn(async () => handle);
    const writes: [FileSystemFileHandle, string][] = [];
    const { session, edit } = startSession({
      pickSaveHandle,
      writeToHandle: async (h, text) => void writes.push([h, text]),
    });
    await session.restored();
    edit(named(buildLab().topology, 'One'));
    await session.save();
    edit(named(buildLab().topology, 'Two'));
    await session.save();

    expect(pickSaveHandle).toHaveBeenCalledTimes(1);
    expect(writes.map(([h, text]) => [h, JSON.parse(text).meta.name])).toEqual([
      [handle, 'One'],
      [handle, 'Two'],
    ]);
  });

  it('shows the validation problem and keeps the current lab when a file is invalid', async () => {
    const { session, edit, topology } = startSession();
    await session.restored();
    const lab = buildLab().topology;
    edit(lab);

    await session.openFile(new File(['{"version":1,"meta":{}}'], 'bad.tracer.json'));
    const problem = session.state.getState().problem;
    expect(problem?.title).toContain('bad.tracer.json');
    expect(problem?.message).toMatch(/meta/);
    expect(topology()).toBe(lab);

    await session.openFile(new File(['not json'], 'worse.tracer.json'));
    expect(session.state.getState().problem?.message).toMatch(/not valid JSON/);
  });

  it('opens a file picked through the picker', async () => {
    const lab = named(buildLab().topology, 'Picked');
    const file = new File([serializeTopology(lab)], 'Picked.tracer.json');
    const { session, topology } = startSession({ pickOpenFile: async () => ({ file }) });
    await session.restored();
    await session.open();
    expect(topology()).toEqual(lab);
  });
});

describe('new lab', () => {
  it('asks before replacing unsaved changes, and only then', async () => {
    const { session, edit, topology } = startSession();
    await session.restored();
    await session.newLab();
    expect(session.state.getState().confirmingNew).toBe(false);

    edit(named(buildLab().topology, 'Work'));
    await session.newLab();
    expect(session.state.getState().confirmingNew).toBe(true);
    expect(topology().meta.name).toBe('Work');

    await session.confirmNewLab();
    expect(session.state.getState().confirmingNew).toBe(false);
    expect(topology().devices).toEqual({});
    expect(session.state.getState().recents.map((lab) => lab.name)).toEqual(['Work']);
  });
});

describe('recent labs', () => {
  it('lists other labs, newest first, and opening one restores it', async () => {
    const { session, topology } = startSession();
    await session.restored();
    const labs = ['A', 'B', 'C'].map((name) => named(buildLab().topology, name));
    for (const lab of labs) await openLab(session, lab);

    const recents = session.state.getState().recents;
    expect(recents.map((lab) => [lab.name, lab.deviceCount])).toEqual([
      ['B', 5],
      ['A', 5],
    ]);

    await session.openRecent(recents[1]!);
    expect(topology()).toEqual(labs[0]);
    expect(session.state.getState().recents.map((lab) => lab.name)).toEqual(['C', 'B']);
  });

  it('keeps the list short', async () => {
    const { session } = startSession();
    await session.restored();
    for (let i = 0; i < RECENT_LIMIT + 3; i++) {
      await openLab(session, named(buildLab().topology, `Lab ${i}`));
    }
    expect(session.state.getState().recents).toHaveLength(RECENT_LIMIT);
  });
});

describe('rename', () => {
  it('renames the lab as one undoable change', async () => {
    const { session, store, topology } = startSession();
    await session.restored();
    session.rename('  Core network  ');
    expect(topology().meta.name).toBe('Core network');
    session.rename('   ');
    expect(topology().meta.name).toBe(DEFAULT_LAB_NAME);
    store.getState().undo();
    expect(topology().meta.name).toBe('Core network');
  });
});
