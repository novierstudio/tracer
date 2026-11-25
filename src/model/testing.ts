import { addDevice, createDevice, type DeviceSpec } from './commands';
import { createIdSource } from './ids';
import type { Result } from './result';
import { PortId, emptyTopology, type Device, type Endpoint } from './topology';
import { Hostname } from './values';

export function expectOk<T, E>(result: Result<T, E>): T {
  if (!result.ok) throw new Error(`Expected success, got ${JSON.stringify(result.error)}`);
  return result.value;
}

export const port = (name: string) => PortId.parse(name);

export const end = (device: Device, name: string): Endpoint => ({
  device: device.id,
  port: port(name),
});

const spec = (
  kind: DeviceSpec['kind'],
  hostname: string,
  ports: [DeviceSpec['ports'][number]['kind'], string][],
): DeviceSpec => ({
  kind,
  model: `${kind}-test`,
  hostname: Hostname.parse(hostname),
  position: { x: 0, y: 0 },
  ports: ports.map(([portKind, name]) => ({ kind: portKind, id: port(name) })),
});

export function buildLab(seed = 1) {
  const ids = createIdSource(seed);
  let topology = emptyTopology({ name: 'Lab', now: new Date('2026-01-01T00:00:00.000Z') });
  const add = (deviceSpec: DeviceSpec) => {
    const device = createDevice(deviceSpec, { ids, topology });
    topology = expectOk(addDevice(topology, device));
    return device;
  };

  const r1 = add(
    spec('router', 'R1', [
      ['gigabitEthernet', 'GigabitEthernet0/0'],
      ['gigabitEthernet', 'GigabitEthernet0/1'],
      ['serial', 'Serial0/0/0'],
    ]),
  );
  const r2 = add(
    spec('router', 'R2', [
      ['gigabitEthernet', 'GigabitEthernet0/0'],
      ['serial', 'Serial0/0/0'],
    ]),
  );
  const sw = add(
    spec('switch', 'SW1', [
      ['fastEthernet', 'FastEthernet0/1'],
      ['fastEthernet', 'FastEthernet0/2'],
      ['gigabitEthernet', 'GigabitEthernet0/1'],
    ]),
  );
  const pc = add(spec('pc', 'PC1', [['fastEthernet', 'FastEthernet0']]));
  const server = add(spec('server', 'Server1', [['fastEthernet', 'FastEthernet0']]));

  return { ids, topology, r1, r2, sw, pc, server };
}
