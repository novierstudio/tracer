// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { deviceSpec } from '@/devices/create';
import type { DeviceModelId } from '@/devices/catalog';
import { createIdSource, PortId, type DeviceId } from '@/model';
import { createEditorStore } from '@/model/store';
import { expectOk } from '@/model/testing';
import { autoLayout } from './edit';
import { snapCentre } from './geometry';
import { layoutTopology } from './layout';

const port = (name: string) => PortId.parse(name);

/** A router with a server and two switches, `hosts` PCs per switch, all piled up in one corner. */
function messyLab(hosts: number) {
  const editor = createEditorStore({ ids: createIdSource(8) });
  let n = 0;
  const add = (model: DeviceModelId) => {
    const names = Object.values(editor.getState().topology.devices).map((d) => d.config.hostname);
    const position = { x: (n * 37) % 200, y: (n++ * 53) % 150 };
    return expectOk(
      editor.getState().addDevice(deviceSpec(model, { position, existingNames: names })),
    );
  };
  const link = (a: DeviceId, aPort: string, b: DeviceId, bPort: string) =>
    expectOk(
      editor.getState().addLink({
        cable: 'straight',
        a: { device: a, port: port(aPort) },
        b: { device: b, port: port(bPort) },
      }),
    );

  const router = add('router-4g');
  const switches = [add('switch-24'), add('switch-24')];
  switches.forEach((sw, i) => {
    link(sw, 'GigabitEthernet0/1', router, `GigabitEthernet0/${i}`);
    for (let h = 0; h < hosts; h++) link(add('pc'), 'FastEthernet0', sw, `FastEthernet0/${h + 1}`);
  });
  link(add('server'), 'GigabitEthernet0', router, 'GigabitEthernet0/2');
  editor.temporal.getState().clear();
  return { editor, router, switches };
}

describe('layoutTopology', () => {
  it('puts routers above switches above hosts, on the grid, with no two devices together', async () => {
    const { editor, router, switches } = messyLab(3);
    const topology = editor.getState().topology;
    const moves = await layoutTopology(topology);
    const at = new Map(Object.values(topology.devices).map((d) => [d.id, d.position]));
    for (const move of moves) at.set(move.device, move.position);

    const y = (id: DeviceId) => at.get(id)!.y;
    for (const sw of switches) expect(y(sw)).toBeGreaterThan(y(router));
    const pcs = Object.values(topology.devices).filter((d) => d.kind === 'pc');
    for (const pc of pcs) expect(y(pc.id)).toBeGreaterThan(Math.max(...switches.map(y)));

    const points = [...at.values()];
    for (const p of points) expect(p).toEqual({ x: snapCentre(p.x), y: snapCentre(p.y) });
    expect(new Set(points.map((p) => `${p.x},${p.y}`)).size).toBe(points.length);
  });

  it('lays out a 20-device lab in under 500 ms', async () => {
    const { editor } = messyLab(8);
    expect(Object.keys(editor.getState().topology.devices)).toHaveLength(20);
    await layoutTopology(editor.getState().topology); // loads ELK
    const started = performance.now();
    await layoutTopology(editor.getState().topology);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe('autoLayout', () => {
  it('moves every device in one undo step', async () => {
    const { editor } = messyLab(2);
    const before = editor.getState().topology;
    await autoLayout({ editor });
    expect(editor.getState().topology).not.toBe(before);
    expect(editor.temporal.getState().pastStates).toHaveLength(1);
    editor.getState().undo();
    expect(editor.getState().topology).toBe(before);
  });

  it('runs ELK on the lab as it was, and drops the result if the lab changed meanwhile', async () => {
    const { editor, router } = messyLab(1);
    const pending = autoLayout({ editor });
    editor.getState().moveDevices([{ device: router, position: { x: 999, y: 999 } }]);
    await pending;
    expect(editor.getState().topology.devices[router]!.position).toEqual({ x: 999, y: 999 });
    expect(editor.temporal.getState().pastStates).toHaveLength(1);
  });
});
