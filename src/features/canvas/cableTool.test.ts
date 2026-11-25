import { describe, expect, it } from 'vitest';
import type { DeviceModelId } from '@/devices/catalog';
import { deviceSpec } from '@/devices/create';
import { PortId, type DeviceId, type Link } from '@/model';
import { createEditorStore } from '@/model/store';
import { expectOk } from '@/model/testing';
import { createCableTool } from './cableTool';

const port = (name: string) => PortId.parse(name);

function setup(...models: DeviceModelId[]) {
  const editor = createEditorStore();
  const ids = models.map((model, i) => {
    const names = Object.values(editor.getState().topology.devices).map((d) => d.config.hostname);
    const spec = deviceSpec(model, { position: { x: i * 100, y: 0 }, existingNames: names });
    return expectOk(editor.getState().addDevice(spec));
  });
  const tool = createCableTool(editor);
  const links = (): Link[] => Object.values(editor.getState().topology.links);
  return { editor, tool, ids, links, state: () => tool.getState() };
}

describe('cable tool', () => {
  it('connects two ports picked from the popover and selects the new link', () => {
    const { editor, tool, ids, links, state } = setup('router-2g2s', 'switch-24');
    const [router, sw] = ids as [DeviceId, DeviceId];

    tool.getState().toggle();
    state().clickDevice(router);
    expect(state().step).toEqual({ at: 'source-port', device: router });
    state().choosePort(port('GigabitEthernet0/1'));
    state().clickDevice(sw);
    expect(state().step).toMatchObject({ at: 'target-port', device: sw });
    state().choosePort(port('FastEthernet0/3'));

    const [link] = links();
    expect(link).toMatchObject({
      cable: 'straight',
      a: { device: router, port: 'GigabitEthernet0/1' },
      b: { device: sw, port: 'FastEthernet0/3' },
    });
    expect(editor.getState().selection).toEqual({
      devices: [],
      links: [link!.id],
      annotations: [],
    });
    expect(state().step).toEqual({ at: 'source' });
    expect(state().notice).toBeNull();
  });

  it('skips the popover on single-port devices and picks crossover for like devices', () => {
    const { tool, ids, links, state } = setup('pc', 'pc');
    const [pc0, pc1] = ids as [DeviceId, DeviceId];

    tool.getState().toggle();
    state().clickDevice(pc0);
    state().clickDevice(pc1);

    expect(links()).toEqual([
      expect.objectContaining({
        cable: 'crossover',
        a: { device: pc0, port: 'FastEthernet0' },
        b: { device: pc1, port: 'FastEthernet0' },
      }),
    ]);
  });

  it('shows the store refusing a port that was taken while the cable was in hand', () => {
    const { editor, tool, ids, links, state } = setup('router-2g2s', 'switch-24', 'switch-24');
    const [router, sw0, sw1] = ids as [DeviceId, DeviceId, DeviceId];

    tool.getState().toggle();
    state().clickDevice(router);
    state().choosePort(port('GigabitEthernet0/0'));
    expectOk(
      editor.getState().addLink({
        cable: 'straight',
        a: { device: router, port: port('GigabitEthernet0/0') },
        b: { device: sw1, port: port('FastEthernet0/1') },
      }),
    );
    state().clickDevice(sw0);
    state().choosePort(port('FastEthernet0/1'));

    expect(state().notice?.message).toBe('Router0 Gi0/0 is already connected to Switch1 Fa0/1.');
    expect(links()).toHaveLength(1);
    expect(state().step).toEqual({
      at: 'target',
      source: { device: router, port: 'GigabitEthernet0/0' },
    });
  });

  it('explains a cable that does not fit the far port', () => {
    const { tool, ids, links, state } = setup('router-2g2s', 'switch-24');
    const [router, sw] = ids as [DeviceId, DeviceId];

    tool.getState().chooseCable('serial');
    state().clickDevice(router);
    state().choosePort(port('Serial0/0/0'));
    state().clickDevice(sw);
    state().choosePort(port('FastEthernet0/1'));

    expect(state().notice?.message).toBe('Switch0 Fa0/1 needs a copper cable, not serial.');
    expect(links()).toEqual([]);
  });

  it('refuses to connect a device to itself', () => {
    const { tool, ids, state } = setup('router-4g');
    const [router] = ids as [DeviceId];

    tool.getState().toggle();
    state().clickDevice(router);
    state().choosePort(port('GigabitEthernet0/0'));
    state().clickDevice(router);

    expect(state().notice?.message).toMatch(/^A cable needs two devices/);
    expect(state().step).toMatchObject({ at: 'target' });
  });

  it('drops the cable in progress on Esc, then leaves the tool on a second Esc', () => {
    const { tool, ids, state } = setup('router-4g', 'switch-24');
    const [router] = ids as [DeviceId];

    expect(state().escape()).toBe(false);
    tool.getState().toggle();
    state().clickDevice(router);
    state().choosePort(port('GigabitEthernet0/0'));

    expect(state().escape()).toBe(true);
    expect(state().step).toEqual({ at: 'source' });
    expect(state().escape()).toBe(true);
    expect(state().step).toBeNull();
  });

  it('keeps the source when the target port picker is dismissed', () => {
    const { tool, ids, state } = setup('router-4g', 'switch-24');
    const [router, sw] = ids as [DeviceId, DeviceId];

    tool.getState().toggle();
    state().clickDevice(router);
    state().choosePort(port('GigabitEthernet0/2'));
    state().clickDevice(sw);
    state().dismissPicker();

    expect(state().step).toEqual({
      at: 'target',
      source: { device: router, port: 'GigabitEthernet0/2' },
    });
  });
});
