// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { deviceSpec } from '@/devices/create';
import type { DeviceModelId } from '@/devices/catalog';
import {
  createIdSource,
  Hostname,
  PortId,
  Topology,
  type AnnotationId,
  type Device,
  type DeviceId,
} from '@/model';
import { createEditorStore } from '@/model/store';
import { expectOk } from '@/model/testing';
import { copyFragment, pasteElements } from './clipboard';

const port = (name: string) => PortId.parse(name);

function lab(...models: DeviceModelId[]) {
  const editor = createEditorStore({ ids: createIdSource(3) });
  const ids = models.map((model, i) => {
    const names = Object.values(editor.getState().topology.devices).map((d) => d.config.hostname);
    const spec = deviceSpec(model, { position: { x: i * 160, y: 0 }, existingNames: names });
    return expectOk(editor.getState().addDevice(spec));
  });
  return { editor, ids, topology: () => editor.getState().topology };
}

function cabledPair() {
  const { editor, ids, topology } = lab('router-2g2s', 'switch-24', 'pc');
  const [router, sw, pc] = ids as [DeviceId, DeviceId, DeviceId];
  expectOk(
    editor.getState().addLink({
      cable: 'straight',
      a: { device: router, port: port('GigabitEthernet0/0') },
      b: { device: sw, port: port('GigabitEthernet0/1') },
    }),
  );
  expectOk(
    editor.getState().addLink({
      cable: 'straight',
      a: { device: pc, port: port('FastEthernet0') },
      b: { device: sw, port: port('FastEthernet0/1') },
    }),
  );
  return { editor, router, sw, pc, topology };
}

describe('copyFragment', () => {
  it('keeps only the links whose two ends are both copied', () => {
    const { router, sw, topology } = cabledPair();
    const fragment = copyFragment(topology(), { devices: [router, sw], notes: [] })!;
    expect(fragment.devices.map((d) => d.id)).toEqual([router, sw]);
    expect(fragment.links).toHaveLength(1);
    expect(fragment.links[0]!.a.device).toBe(router);
  });

  it('is undefined when nothing copyable is selected', () => {
    const { topology } = cabledPair();
    expect(copyFragment(topology(), { devices: [], notes: [] })).toBeUndefined();
  });
});

describe('pasteElements', () => {
  it('gives copies new ids, MACs, the next free hostnames and offset positions', () => {
    const { router, sw, topology, editor } = cabledPair();
    const fragment = copyFragment(topology(), { devices: [router, sw], notes: [] })!;
    const pasted = pasteElements(topology(), fragment, {
      ids: createIdSource(11),
      offset: { x: 32, y: 32 },
    });

    const [newRouter, newSwitch] = pasted.devices;
    expect(newRouter!.id).not.toBe(router);
    expect(newSwitch!.id).not.toBe(sw);
    expect(pasted.devices.map((d) => d.config.hostname)).toEqual(['Router1', 'Switch1']);
    expect(newRouter!.position).toEqual({ x: 32, y: 32 });
    expect(newSwitch!.position).toEqual({ x: 192, y: 32 });

    const macs = (devices: readonly Device[]) =>
      devices.flatMap((d) => d.ports.flatMap((p) => (p.kind === 'serial' ? [] : [p.mac])));
    const all = macs([...Object.values(topology().devices), ...pasted.devices]);
    expect(new Set(all).size).toBe(all.length);

    expect(pasted.links).toHaveLength(1);
    const [link] = pasted.links;
    expect(link!.id).not.toBe(fragment.links[0]!.id);
    expect(link!.a).toEqual({ device: newRouter!.id, port: port('GigabitEthernet0/0') });
    expect(link!.b).toEqual({ device: newSwitch!.id, port: port('GigabitEthernet0/1') });

    // The store takes the batch as it is, and the result is still a valid lab.
    expectOk(editor.getState().addElements(pasted));
    expect(Topology.safeParse(editor.getState().topology).success).toBe(true);
    expect(Object.keys(editor.getState().topology.links)).toHaveLength(3);
  });

  it('keeps a renamed device stem and copies its config', () => {
    const { editor, ids, topology } = lab('pc');
    const [pc] = ids as [DeviceId];
    expectOk(editor.getState().renameDevice({ device: pc, hostname: Hostname.parse('Lab-PC7') }));
    const fragment = copyFragment(topology(), { devices: [pc], notes: [] })!;
    const [copy] = pasteElements(topology(), fragment, {
      ids: createIdSource(2),
      offset: { x: 0, y: 0 },
    }).devices;
    expect(copy!.config).toEqual({ ...topology().devices[pc]!.config, hostname: 'Lab-PC0' });
  });

  it('copies notes with fresh ids', () => {
    const { editor, topology } = lab();
    const note = expectOk(editor.getState().addNote({ position: { x: 0, y: 0 }, text: 'VLAN 10' }));
    const fragment = copyFragment(topology(), { devices: [], notes: [note as AnnotationId] })!;
    const { annotations } = pasteElements(topology(), fragment, {
      ids: createIdSource(4),
      offset: { x: 16, y: 0 },
    });
    expect(annotations).toEqual([
      {
        id: expect.not.stringMatching(note),
        kind: 'note',
        position: { x: 16, y: 0 },
        text: 'VLAN 10',
      },
    ]);
  });
});
