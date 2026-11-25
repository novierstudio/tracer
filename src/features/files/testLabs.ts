import { createDevice } from '@/devices/create';
import type { DeviceModelId } from '@/devices/catalog';
import {
  addDevice,
  addLink,
  createIdSource,
  emptyTopology,
  parseTopology,
  PortId,
  type Device,
  type Topology,
} from '@/model';
import { expectOk } from '@/model/testing';

/**
 * A classroom-sized lab of `pcs` PCs: two routers on a crossover, a 24-port switch behind each, and
 * the PCs split between the switches. Parsed, so it has every schema default a saved lab has.
 */
export function classroomLab(pcs: number): Topology {
  const ids = createIdSource(7);
  let topology = emptyTopology({ name: 'Classroom', now: new Date('2026-01-01T00:00:00.000Z') });
  const add = (model: DeviceModelId, x: number, y: number) => {
    const names = Object.values(topology.devices).map((device) => device.config.hostname);
    const device = createDevice(model, {
      id: ids.deviceId(),
      position: { x, y },
      existingNames: names,
      macSeed: names.length + 1,
    });
    topology = expectOk(addDevice(topology, device));
    return device;
  };
  const link = (
    a: Device,
    aPort: string,
    b: Device,
    bPort: string,
    cable: 'straight' | 'crossover' = 'straight',
  ) => {
    topology = expectOk(
      addLink(topology, {
        id: ids.linkId(),
        cable,
        a: { device: a.id, port: PortId.parse(aPort) },
        b: { device: b.id, port: PortId.parse(bPort) },
      }),
    );
  };

  const routers = [add('router-4g', 0, 0), add('router-4g', 400, 0)] as const;
  link(routers[0], 'GigabitEthernet0/1', routers[1], 'GigabitEthernet0/1', 'crossover');
  const switches = routers.map((router, i) => {
    const sw = add('switch-24', i * 400, 160);
    link(router, 'GigabitEthernet0/0', sw, 'GigabitEthernet0/1');
    return sw;
  });
  for (let n = 0; n < pcs; n++) {
    const side = n % 2;
    const pc = add('pc', side * 400 + (n >> 1) * 80 - 200, 320);
    link(pc, 'FastEthernet0', switches[side]!, `FastEthernet0/${(n >> 1) + 1}`);
  }
  return expectOk(parseTopology(topology));
}
