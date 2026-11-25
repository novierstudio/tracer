// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { DeviceSpec } from './commands';
import { createIdSource } from './ids';
import { HISTORY_LIMIT, createEditorStore } from './store';
import { buildLab, end, expectOk, port } from './testing';
import { emptyTopology } from './topology';
import { Hostname, Ipv4Address, PrefixLength } from './values';

const routerSpec: DeviceSpec = {
  kind: 'router',
  model: 'router-test',
  hostname: Hostname.parse('R9'),
  position: { x: 10, y: 20 },
  ports: [
    { kind: 'gigabitEthernet', id: port('GigabitEthernet0/0') },
    { kind: 'serial', id: port('Serial0/0/0') },
  ],
};

function labStore() {
  const lab = buildLab();
  return { ...lab, store: createEditorStore({ topology: lab.topology, ids: createIdSource(5) }) };
}

describe('editor store', () => {
  it('undoes each command back to the exact earlier topology, then redoes it', () => {
    const { store, sw, pc, r1 } = labStore();
    const editor = () => store.getState();
    const snapshots = [editor().topology];
    const record = () => snapshots.push(editor().topology);

    const routerId = expectOk(editor().addDevice(routerSpec));
    record();
    expectOk(
      editor().addLink({
        cable: 'straight',
        a: end(pc, 'FastEthernet0'),
        b: end(sw, 'FastEthernet0/1'),
      }),
    );
    record();
    editor().moveDevices([{ device: routerId, position: { x: 300, y: 300 } }]);
    record();
    expectOk(editor().renameDevice({ device: routerId, hostname: Hostname.parse('Edge') }));
    record();
    if (r1.kind !== 'router') throw new Error('R1 is not a router');
    expectOk(
      editor().updateConfig({
        device: r1.id,
        kind: 'router',
        config: {
          ...r1.config,
          interfaces: {
            ...r1.config.interfaces,
            [port('GigabitEthernet0/0')]: {
              shutdown: false,
              ipv4: {
                address: Ipv4Address.parse('10.0.0.1'),
                prefixLength: PrefixLength.parse(30),
              },
            },
          },
        },
      }),
    );
    record();
    editor().removeDevices([sw.id]);
    record();

    for (let step = snapshots.length - 2; step >= 0; step--) {
      editor().undo();
      expect(editor().topology).toEqual(snapshots[step]);
    }
    for (let step = 1; step < snapshots.length; step++) {
      editor().redo();
      expect(editor().topology).toEqual(snapshots[step]);
    }
  });

  it('adds no history for a rejected command', () => {
    const { store, sw, pc, server } = labStore();
    const editor = () => store.getState();
    expectOk(editor().addDevice(routerSpec));
    const beforeLink = editor().topology;
    expectOk(
      editor().addLink({
        cable: 'straight',
        a: end(pc, 'FastEthernet0'),
        b: end(sw, 'FastEthernet0/1'),
      }),
    );
    const afterLink = editor().topology;

    const rejected = editor().addLink({
      cable: 'straight',
      a: end(server, 'FastEthernet0'),
      b: end(sw, 'FastEthernet0/1'),
    });

    expect(rejected.ok || rejected.error.kind).toBe('port-in-use');
    expect(editor().topology).toBe(afterLink);
    editor().undo();
    expect(editor().topology).toEqual(beforeLink);
  });

  it('keeps selection out of undo history', () => {
    const { store, pc, server } = labStore();
    const editor = () => store.getState();
    editor().moveDevices([{ device: pc.id, position: { x: 1, y: 1 } }]);
    const beforeMove = buildLab().topology;

    editor().select({ devices: [server.id], links: [] });
    editor().undo();

    expect(editor().topology).toEqual(beforeMove);
    expect(editor().selection).toEqual({ devices: [server.id], links: [], annotations: [] });
  });

  it('drops removed devices and their links from the selection', () => {
    const { store, sw, pc, server } = labStore();
    const editor = () => store.getState();
    const linkId = expectOk(
      editor().addLink({
        cable: 'straight',
        a: end(pc, 'FastEthernet0'),
        b: end(sw, 'FastEthernet0/1'),
      }),
    );
    editor().select({ devices: [pc.id, server.id], links: [linkId] });

    editor().removeDevices([pc.id]);

    expect(editor().selection).toEqual({ devices: [server.id], links: [], annotations: [] });
  });

  it('drops a device from the selection when undo removes it', () => {
    const { store } = labStore();
    const editor = () => store.getState();
    const routerId = expectOk(editor().addDevice(routerSpec));
    editor().select({ devices: [routerId], links: [] });

    editor().undo();

    expect(editor().selection).toEqual({ devices: [], links: [], annotations: [] });
  });

  it('records a whole drag as one undo step', () => {
    const { store, pc, server } = labStore();
    const editor = () => store.getState();
    editor().moveDevices([{ device: server.id, position: { x: 50, y: 50 } }]);
    const beforeDrag = editor().topology;

    editor().beginGesture();
    for (let x = 1; x <= 20; x++) editor().moveDevices([{ device: pc.id, position: { x, y: x } }]);
    editor().endGesture();
    const afterDrag = editor().topology;

    expect(afterDrag.devices[pc.id]?.position).toEqual({ x: 20, y: 20 });
    editor().undo();
    expect(editor().topology).toEqual(beforeDrag);
    editor().redo();
    expect(editor().topology).toEqual(afterDrag);
    editor().undo();
    editor().undo();
    expect(editor().topology).toEqual(buildLab().topology);
  });

  it('adds no history for a gesture that changes nothing', () => {
    const { store, pc } = labStore();
    const editor = () => store.getState();
    editor().moveDevices([{ device: pc.id, position: { x: 7, y: 7 } }]);
    const afterMove = editor().topology;

    editor().beginGesture();
    editor().endGesture();
    editor().undo();

    expect(editor().topology).toEqual(buildLab().topology);
    expect(editor().topology).not.toEqual(afterMove);
  });

  it(`keeps only the latest ${HISTORY_LIMIT} steps`, () => {
    const { store, pc } = labStore();
    const editor = () => store.getState();
    const extra = 5;
    for (let x = 1; x <= HISTORY_LIMIT + extra; x++) {
      editor().moveDevices([{ device: pc.id, position: { x, y: 0 } }]);
    }

    for (let i = 0; i < HISTORY_LIMIT + extra; i++) editor().undo();

    expect(editor().topology.devices[pc.id]?.position).toEqual({ x: extra, y: 0 });
  });

  it('replaces the topology on load and forgets the old history', () => {
    const { store, pc } = labStore();
    const editor = () => store.getState();
    editor().moveDevices([{ device: pc.id, position: { x: 3, y: 3 } }]);
    editor().select({ devices: [pc.id], links: [] });
    const fresh = emptyTopology({ name: 'Fresh', now: new Date('2026-02-01T00:00:00.000Z') });

    editor().load(fresh);
    editor().undo();

    expect(editor().topology).toEqual(fresh);
    expect(editor().selection).toEqual({ devices: [], links: [], annotations: [] });
  });

  it('undoes power, cable and lab name changes one step each', () => {
    const lab = buildLab();
    const store = createEditorStore({
      topology: lab.topology,
      ids: createIdSource(5),
      now: () => new Date('2026-05-06T00:00:00.000Z'),
    });
    const editor = () => store.getState();
    const snapshots = [editor().topology];
    const record = () => snapshots.push(editor().topology);

    expectOk(editor().setPowered({ device: lab.r1.id, powered: false }));
    record();
    const link = expectOk(
      editor().addLink({
        cable: 'straight',
        a: end(lab.pc, 'FastEthernet0'),
        b: end(lab.sw, 'FastEthernet0/1'),
      }),
    );
    record();
    expectOk(editor().setLinkCable({ link, cable: 'crossover' }));
    record();
    editor().renameLab('Branch');
    record();

    expect(editor().topology.devices[lab.r1.id]?.powered).toBe(false);
    expect(editor().topology.links[link]?.cable).toBe('crossover');
    expect(editor().topology.meta).toMatchObject({
      name: 'Branch',
      updatedAt: '2026-05-06T00:00:00.000Z',
    });
    for (let step = snapshots.length - 2; step >= 0; step--) {
      editor().undo();
      expect(editor().topology).toEqual(snapshots[step]);
    }
  });

  it('adds no history for renaming the lab to its own name', () => {
    const { store } = labStore();
    store.getState().renameLab(store.getState().topology.meta.name);
    expect(store.temporal.getState().pastStates).toHaveLength(0);
  });
});
