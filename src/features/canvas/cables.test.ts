import { describe, expect, it } from 'vitest';
import { deviceSpec } from '@/devices/create';
import type { DeviceModelId } from '@/devices/catalog';
import { PortId, type DeviceId } from '@/model';
import { createEditorStore } from '@/model/store';
import { expectOk } from '@/model/testing';
import { autoCable, onlyPort, planLink, portOptions, type PortEnd } from './cables';

const port = (name: string) => PortId.parse(name);

function lab(...models: DeviceModelId[]) {
  const editor = createEditorStore();
  const ids = models.map((model, i) => {
    const names = Object.values(editor.getState().topology.devices).map((d) => d.config.hostname);
    const spec = deviceSpec(model, { position: { x: i * 100, y: 0 }, existingNames: names });
    return expectOk(editor.getState().addDevice(spec));
  });
  return { editor, ids, topology: () => editor.getState().topology };
}

describe('autoCable', () => {
  const end = (device: PortEnd['device'], portKind: PortEnd['port'] = 'fastEthernet'): PortEnd => ({
    device,
    port: portKind,
  });

  it.each([
    ['pc', 'switch', 'straight'],
    ['server', 'switch', 'straight'],
    ['router', 'switch', 'straight'],
    ['switch', 'router', 'straight'],
    ['switch', 'switch', 'crossover'],
    ['router', 'router', 'crossover'],
    ['pc', 'router', 'crossover'],
    ['pc', 'pc', 'crossover'],
  ] as const)('connects a %s to a %s with %s', (a, b, cable) => {
    expect(autoCable(end(a), end(b))).toBe(cable);
  });

  it('uses serial between serial ports and refuses to mix serial with copper', () => {
    expect(autoCable(end('router', 'serial'), end('router', 'serial'))).toBe('serial');
    expect(autoCable(end('router', 'serial'), end('router', 'gigabitEthernet'))).toBeUndefined();
  });
});

describe('portOptions', () => {
  it('lists free ports first and names the far end of used ones', () => {
    const { editor, ids, topology } = lab('router-2g2s', 'switch-24');
    const [router, sw] = ids as [DeviceId, DeviceId];
    expectOk(
      editor.getState().addLink({
        cable: 'straight',
        a: { device: router, port: port('GigabitEthernet0/0') },
        b: { device: sw, port: port('FastEthernet0/1') },
      }),
    );

    expect(portOptions(topology(), router, undefined)).toEqual([
      { id: 'GigabitEthernet0/1', kind: 'gigabitEthernet', short: 'Gi0/1', status: 'free' },
      { id: 'Serial0/0/0', kind: 'serial', short: 'Se0/0/0', status: 'free' },
      { id: 'Serial0/0/1', kind: 'serial', short: 'Se0/0/1', status: 'free' },
      {
        id: 'GigabitEthernet0/0',
        kind: 'gigabitEthernet',
        short: 'Gi0/0',
        status: 'used',
        peer: 'Switch0 Fa0/1',
      },
    ]);
  });

  it('marks ports the cable cannot reach as incompatible', () => {
    const { ids, topology } = lab('router-2g2s');
    const [router] = ids as [DeviceId];

    const options = portOptions(topology(), router, 'serial');
    expect(options.map(({ short, status }) => [short, status])).toEqual([
      ['Se0/0/0', 'free'],
      ['Se0/0/1', 'free'],
      ['Gi0/0', 'incompatible'],
      ['Gi0/1', 'incompatible'],
    ]);
  });

  it('skips the picker only for a device with one suitable port, and only while it is free', () => {
    const { editor, ids, topology } = lab('pc', 'router-2g2s', 'switch-24');
    const [pc, router, sw] = ids as [DeviceId, DeviceId, DeviceId];

    expect(onlyPort(topology(), pc, undefined)).toBe('FastEthernet0');
    expect(onlyPort(topology(), router, undefined)).toBeUndefined();
    expect(onlyPort(topology(), router, 'serial')).toBeUndefined();

    expectOk(
      editor.getState().addLink({
        cable: 'straight',
        a: { device: pc, port: port('FastEthernet0') },
        b: { device: sw, port: port('FastEthernet0/1') },
      }),
    );
    expect(onlyPort(topology(), pc, undefined)).toBeUndefined();
  });
});

describe('planLink', () => {
  it('makes the first end DCE on a serial link', () => {
    const { ids, topology } = lab('router-2g2s', 'router-2g2s');
    const [r0, r1] = ids as [DeviceId, DeviceId];
    const a = { device: r0, port: port('Serial0/0/0') };
    const b = { device: r1, port: port('Serial0/0/1') };

    expect(planLink(topology(), 'auto', a, b)).toEqual({
      ok: true,
      value: { cable: 'serial', a, b, dce: 'a' },
    });
  });

  it('rejects a cable that starts and ends on the same device', () => {
    const { ids, topology } = lab('router-4g');
    const [router] = ids as [DeviceId];
    const plan = planLink(
      topology(),
      'auto',
      { device: router, port: port('GigabitEthernet0/0') },
      { device: router, port: port('GigabitEthernet0/1') },
    );
    expect(plan).toMatchObject({ ok: false, error: { kind: 'same-device' } });
  });
});
