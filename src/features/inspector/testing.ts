import type { DeviceModelId } from '@/devices/catalog';
import { createDevice } from '@/devices/create';
import {
  addDevice,
  addLink,
  createIdSource,
  createLink,
  DeviceId,
  emptyTopology,
  Hostname,
  Ipv4Address,
  PortId,
  PrefixLength,
  type Device,
  type LinkSpec,
  type Topology,
} from '@/model';
import { expectOk } from '@/model/testing';

const cidr = (address: string, prefixLength: number) => ({
  address: Ipv4Address.parse(address),
  prefixLength: PrefixLength.parse(prefixLength),
});

/**
 * A small branch office built from catalog models, for tests and screenshots:
 * R1 routes for the LAN and has a serial WAN link to R2; SW1 connects R1, PC1 and Server1.
 */
export function buildOffice() {
  const ids = createIdSource(7);
  let topology: Topology = emptyTopology({ name: 'Office', now: new Date('2026-01-01T00:00:00Z') });
  let seed = 1;

  const add = (model: DeviceModelId, hostname: string, edit: (device: Device) => Device) => {
    const device = createDevice(model, {
      id: DeviceId.parse(`dev_${hostname}`),
      position: { x: seed * 120, y: 0 },
      existingNames: [],
      macSeed: seed++,
    });
    const named = edit({
      ...device,
      config: { ...device.config, hostname: Hostname.parse(hostname) },
    } as Device);
    topology = expectOk(addDevice(topology, named));
    return named;
  };
  const connect = (spec: LinkSpec) => {
    const link = createLink(spec, { ids, topology });
    topology = expectOk(addLink(topology, link));
    return link;
  };
  const end = (device: Device, port: string) => ({ device: device.id, port: PortId.parse(port) });

  const r1 = add('router-2g2s', 'R1', (device) => {
    if (device.kind !== 'router') return device;
    const interfaces = { ...device.config.interfaces };
    interfaces[PortId.parse('GigabitEthernet0/0')] = {
      shutdown: false,
      ipv4: cidr('192.168.1.1', 24),
    };
    interfaces[PortId.parse('Serial0/0/0')] = { shutdown: false, ipv4: cidr('10.0.0.1', 30) };
    return { ...device, config: { ...device.config, interfaces } };
  });
  const r2 = add('router-2g2s', 'R2', (device) => device);
  const sw = add('switch-24', 'SW1', (device) => device);
  const pc = add('pc', 'PC1', (device) =>
    device.kind === 'pc'
      ? {
          ...device,
          config: {
            ...device.config,
            ipv4: {
              mode: 'static',
              address: cidr('192.168.1.10', 24),
              gateway: Ipv4Address.parse('192.168.1.1'),
              dns: Ipv4Address.parse('192.168.1.53'),
            },
          },
        }
      : device,
  );
  const server = add('server', 'Server1', (device) => device);

  const uplink = connect({
    cable: 'straight',
    a: end(r1, 'GigabitEthernet0/0'),
    b: end(sw, 'GigabitEthernet0/1'),
  });
  const pcLink = connect({
    cable: 'straight',
    a: end(sw, 'FastEthernet0/1'),
    b: end(pc, 'FastEthernet0'),
  });
  connect({ cable: 'straight', a: end(sw, 'FastEthernet0/2'), b: end(server, 'GigabitEthernet0') });
  const wan = connect({
    cable: 'serial',
    a: end(r1, 'Serial0/0/0'),
    b: end(r2, 'Serial0/0/0'),
    dce: 'a',
  });

  return { topology, r1, r2, sw, pc, server, uplink, pcLink, wan };
}
