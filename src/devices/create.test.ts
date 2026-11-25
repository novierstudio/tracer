import { describe, expect, it } from 'vitest';
import {
  addDevice,
  Device,
  DeviceId,
  emptyTopology,
  Topology,
  type Device as DeviceValue,
} from '@/model';
import { DEVICE_MODELS, type DeviceModelId } from './catalog';
import { createDevice, deviceSpec, nextHostname } from './create';

const at = { x: 10, y: 20 };

function make(modelId: DeviceModelId, n = 0, existingNames: string[] = []): DeviceValue {
  return createDevice(modelId, {
    id: DeviceId.parse(`dev_${n}`),
    position: at,
    existingNames,
    macSeed: n + 1,
  });
}

const EXPECTED_PORTS: Record<DeviceModelId, string[]> = {
  'router-2g2s': ['GigabitEthernet0/0', 'GigabitEthernet0/1', 'Serial0/0/0', 'Serial0/0/1'],
  'router-4g': [0, 1, 2, 3].map((n) => `GigabitEthernet0/${n}`),
  'switch-24': [
    ...Array.from({ length: 24 }, (_, i) => `FastEthernet0/${i + 1}`),
    'GigabitEthernet0/1',
    'GigabitEthernet0/2',
  ],
  'switch-48': [
    ...Array.from({ length: 48 }, (_, i) => `FastEthernet0/${i + 1}`),
    'GigabitEthernet0/1',
    'GigabitEthernet0/2',
  ],
  pc: ['FastEthernet0'],
  laptop: ['GigabitEthernet0'],
  server: ['GigabitEthernet0'],
};

describe('createDevice', () => {
  it.each(DEVICE_MODELS.map((model) => model.id))('builds a valid %s', (modelId) => {
    const device = make(modelId);

    expect(Device.parse(device)).toEqual(device);
    expect(device).toMatchObject({ id: 'dev_0', model: modelId, position: at, powered: true });
    expect(device.ports.map((port) => port.id)).toEqual(EXPECTED_PORTS[modelId]);
  });

  it('builds a topology holding one of every model', () => {
    let topology = emptyTopology({ name: 'All', now: new Date('2026-01-01T00:00:00Z') });
    const names: string[] = [];
    DEVICE_MODELS.forEach((model, n) => {
      const device = make(model.id, n, names);
      names.push(device.config.hostname);
      const result = addDevice(topology, device);
      if (!result.ok) throw new Error(JSON.stringify(result.error));
      topology = result.value;
    });

    expect(Topology.parse(topology)).toEqual(topology);
    expect(names).toEqual([
      'Router0',
      'Router1',
      'Switch0',
      'Switch1',
      'PC0',
      'Laptop0',
      'Server0',
    ]);
  });

  it('configures exactly the device ports on routers and switches', () => {
    for (const modelId of ['router-2g2s', 'switch-48'] as const) {
      const device = make(modelId);
      if (device.kind !== 'router' && device.kind !== 'switch') throw new Error(device.kind);
      expect(Object.keys(device.config.interfaces)).toEqual(device.ports.map((port) => port.id));
    }
  });

  it('gives Ethernet ports MACs and serial ports none', () => {
    const ports = make('router-2g2s').ports;
    expect(
      ports.map(
        (port) => port.kind === 'serial' || /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(port.mac),
      ),
    ).toEqual([true, true, true, true]);
    expect(ports.filter((port) => 'mac' in port)).toHaveLength(2);
  });

  it('gives the same MACs for the same seed and different ones for another seed', () => {
    const macs = (seed: number) =>
      createDevice('switch-24', {
        id: DeviceId.parse('dev_a'),
        position: at,
        existingNames: [],
        macSeed: seed,
      }).ports.map((port) => ('mac' in port ? port.mac : ''));

    expect(macs(7)).toEqual(macs(7));
    expect(new Set(macs(7)).size).toBe(26);
    expect(macs(8)).not.toEqual(macs(7));
  });

  it('makes a laptop a pc with its own model', () => {
    expect(make('laptop')).toMatchObject({
      kind: 'pc',
      model: 'laptop',
      config: { hostname: 'Laptop0' },
    });
  });
});

describe('nextHostname', () => {
  it.each([
    [[], 'Router0'],
    [['Router0'], 'Router1'],
    [['Router0', 'Router1', 'Router3'], 'Router2'],
    [['router0', 'ROUTER1'], 'Router2'],
    [['Switch0', 'PC0', 'Router00'], 'Router0'],
  ])('with %j taken gives %s', (taken, expected) => {
    expect(nextHostname('Router', taken)).toBe(expected);
  });
});

describe('deviceSpec', () => {
  it('describes the model for the editor store', () => {
    expect(deviceSpec('pc', { position: at, existingNames: ['PC0'] })).toMatchObject({
      kind: 'pc',
      model: 'pc',
      hostname: 'PC1',
      position: at,
      ports: [{ kind: 'fastEthernet', id: 'FastEthernet0' }],
    });
  });
});
