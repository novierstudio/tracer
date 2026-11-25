// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  addDevice,
  addLink,
  createDevice,
  createLink,
  moveDevices,
  removeDevices,
  removeLinks,
  renameDevice,
  updateConfig,
  type LinkSpec,
} from './commands';
import { DeviceId, LinkId, createIdSource } from './ids';
import { buildLab, end, expectOk, port } from './testing';
import { linkAt, type Topology } from './topology';
import { Hostname, Ipv4Address, PrefixLength } from './values';

const linkIds = createIdSource(99);

function connect(topology: Topology, spec: LinkSpec) {
  const link = createLink(spec, { ids: linkIds, topology });
  return { link, topology: expectOk(addLink(topology, link)) };
}

describe('addDevice', () => {
  it('adds the device under its id', () => {
    const { topology, ids } = buildLab();
    const device = createDevice(
      {
        kind: 'pc',
        model: 'pc-test',
        hostname: Hostname.parse('PC9'),
        position: { x: 40, y: 80 },
        ports: [{ kind: 'fastEthernet', id: port('FastEthernet0') }],
      },
      { ids, topology },
    );

    const next = expectOk(addDevice(topology, device));

    expect(next.devices[device.id]).toEqual(device);
    expect(Object.keys(next.devices)).toHaveLength(Object.keys(topology.devices).length + 1);
  });

  it('rejects a device whose id is taken', () => {
    const { topology, pc } = buildLab();

    expect(addDevice(topology, { ...pc, position: { x: 1, y: 1 } })).toEqual({
      ok: false,
      error: { kind: 'duplicate-id', id: pc.id },
    });
  });

  it('rejects a device whose interface config does not cover its ports', () => {
    const { topology, r1 } = buildLab();
    if (r1.kind !== 'router') throw new Error('R1 is not a router');
    const device = {
      ...r1,
      id: DeviceId.parse('dev_other'),
      config: { ...r1.config, interfaces: {} },
    };

    const result = addDevice(topology, device);

    expect(result.ok || result.error.kind).toBe('interfaces-mismatch');
  });

  it('rejects a device that lists the same port twice', () => {
    const { topology, pc } = buildLab();
    const [nic] = pc.ports;
    if (!nic) throw new Error('PC has no port');
    const device = { ...pc, id: DeviceId.parse('dev_twin'), ports: [nic, nic] };

    const result = addDevice(topology, device);

    expect(result.ok || result.error.kind).toBe('duplicate-port');
  });

  it('rejects a port whose name does not match its kind', () => {
    const { topology, ids } = buildLab();
    const device = createDevice(
      {
        kind: 'pc',
        model: 'pc-test',
        hostname: Hostname.parse('PC9'),
        position: { x: 0, y: 0 },
        ports: [{ kind: 'gigabitEthernet', id: port('Serial0/0/1') }],
      },
      { ids, topology },
    );

    expect(addDevice(topology, device)).toEqual({
      ok: false,
      error: {
        kind: 'port-name-mismatch',
        device: device.id,
        port: 'Serial0/0/1',
        portKind: 'gigabitEthernet',
      },
    });
  });
});

describe('createDevice', () => {
  it('gives each Ethernet port a MAC address no other port has, and serial ports none', () => {
    const { topology } = buildLab();
    const ports = Object.values(topology.devices).flatMap((device) => device.ports);
    const macs = ports.flatMap((p) => (p.kind === 'serial' ? [] : [p.mac]));

    expect(macs).toHaveLength(ports.filter((p) => p.kind !== 'serial').length);
    expect(new Set(macs).size).toBe(macs.length);
    expect(ports.filter((p) => p.kind === 'serial').every((p) => !('mac' in p))).toBe(true);
  });

  it('starts router interfaces shut down and switch ports up in VLAN 1', () => {
    const { r1, sw } = buildLab();

    expect(r1.kind === 'router' && r1.config.interfaces[port('GigabitEthernet0/0')]).toEqual({
      shutdown: true,
    });
    expect(sw.kind === 'switch' && sw.config.interfaces[port('FastEthernet0/1')]).toEqual({
      shutdown: false,
      switchport: { mode: 'access', vlan: 1 },
    });
    expect(sw.kind === 'switch' && sw.config.vlans).toEqual({ 1: { name: 'default' } });
  });
});

describe('removeDevices', () => {
  it('removes the device and every link attached to it, and keeps other links', () => {
    const lab = buildLab();
    const toPc = connect(lab.topology, {
      cable: 'straight',
      a: end(lab.sw, 'FastEthernet0/1'),
      b: end(lab.pc, 'FastEthernet0'),
    });
    const toServer = connect(toPc.topology, {
      cable: 'straight',
      a: end(lab.sw, 'FastEthernet0/2'),
      b: end(lab.server, 'FastEthernet0'),
    });
    const toRouter = connect(toServer.topology, {
      cable: 'straight',
      a: end(lab.r1, 'GigabitEthernet0/0'),
      b: end(lab.sw, 'GigabitEthernet0/1'),
    });

    const next = removeDevices(toRouter.topology, [lab.pc.id, lab.r1.id]);

    expect(Object.keys(next.devices).sort()).toEqual([lab.r2.id, lab.sw.id, lab.server.id].sort());
    expect(Object.keys(next.links)).toEqual([toServer.link.id]);
  });

  it('leaves the topology as it was when none of the ids exist', () => {
    const { topology } = buildLab();

    expect(removeDevices(topology, [DeviceId.parse('dev_missing')])).toEqual(topology);
  });
});

describe('moveDevices', () => {
  it('moves only the listed devices', () => {
    const { topology, pc, server } = buildLab();

    const next = moveDevices(topology, [{ device: pc.id, position: { x: 120, y: -40 } }]);

    expect(next.devices[pc.id]?.position).toEqual({ x: 120, y: -40 });
    expect(next.devices[server.id]?.position).toEqual(server.position);
  });
});

describe('renameDevice', () => {
  it('sets the hostname in the device config', () => {
    const { topology, r1 } = buildLab();

    const next = expectOk(
      renameDevice(topology, { device: r1.id, hostname: Hostname.parse('Edge') }),
    );

    expect(next.devices[r1.id]?.config.hostname).toBe('Edge');
  });

  it('fails for a device that does not exist', () => {
    const { topology } = buildLab();
    const device = DeviceId.parse('dev_missing');

    expect(renameDevice(topology, { device, hostname: Hostname.parse('X') })).toEqual({
      ok: false,
      error: { kind: 'device-not-found', device },
    });
  });
});

describe('addLink', () => {
  it('connects two free Ethernet ports', () => {
    const { topology, pc, sw } = buildLab();

    const { link, topology: next } = connect(topology, {
      cable: 'straight',
      a: end(pc, 'FastEthernet0'),
      b: end(sw, 'FastEthernet0/1'),
    });

    expect(next.links[link.id]).toEqual(link);
    expect(linkAt(next, end(sw, 'FastEthernet0/1'))).toEqual(link);
  });

  it('connects two serial ports and records which end is DCE', () => {
    const { topology, r1, r2 } = buildLab();

    const { link, topology: next } = connect(topology, {
      cable: 'serial',
      a: end(r1, 'Serial0/0/0'),
      b: end(r2, 'Serial0/0/0'),
      dce: 'a',
    });

    expect(next.links[link.id]).toMatchObject({ cable: 'serial', dce: 'a' });
  });

  it('rejects a port that is already connected', () => {
    const { topology, pc, sw, server } = buildLab();
    const first = connect(topology, {
      cable: 'straight',
      a: end(pc, 'FastEthernet0'),
      b: end(sw, 'FastEthernet0/1'),
    });
    const second = createLink(
      { cable: 'straight', a: end(server, 'FastEthernet0'), b: end(sw, 'FastEthernet0/1') },
      { ids: linkIds, topology: first.topology },
    );

    expect(addLink(first.topology, second)).toEqual({
      ok: false,
      error: { kind: 'port-in-use', endpoint: end(sw, 'FastEthernet0/1'), link: first.link.id },
    });
  });

  it.each([
    ['a copper cable on a serial port', 'straight', 'Serial0/0/0', 'GigabitEthernet0/0'],
    ['a serial cable on an Ethernet port', 'serial', 'GigabitEthernet0/0', 'Serial0/0/0'],
  ] as const)('rejects %s', (_, cable, r1Port, r2Port) => {
    const { topology, r1, r2 } = buildLab();
    const spec: LinkSpec =
      cable === 'serial'
        ? { cable, a: end(r1, r1Port), b: end(r2, r2Port), dce: 'a' }
        : { cable, a: end(r1, r1Port), b: end(r2, r2Port) };
    const link = createLink(spec, { ids: linkIds, topology });

    expect(addLink(topology, link)).toEqual({
      ok: false,
      error: {
        kind: 'cable-mismatch',
        endpoint: end(r1, r1Port),
        cable,
        portKind: cable === 'serial' ? 'gigabitEthernet' : 'serial',
      },
    });
  });

  it('rejects a link to a device or port that does not exist', () => {
    const { topology, pc, sw } = buildLab();
    const ghost = { device: DeviceId.parse('dev_ghost'), port: port('FastEthernet0') };
    const toGhost = createLink(
      { cable: 'straight', a: end(pc, 'FastEthernet0'), b: ghost },
      { ids: linkIds, topology },
    );
    const toMissingPort = createLink(
      { cable: 'straight', a: end(pc, 'FastEthernet0'), b: end(sw, 'FastEthernet0/9') },
      { ids: linkIds, topology },
    );

    expect(addLink(topology, toGhost)).toEqual({
      ok: false,
      error: { kind: 'device-not-found', device: ghost.device },
    });
    expect(addLink(topology, toMissingPort)).toEqual({
      ok: false,
      error: { kind: 'port-not-found', endpoint: end(sw, 'FastEthernet0/9') },
    });
  });

  it('rejects a link whose two ends are the same port', () => {
    const { topology, sw } = buildLab();
    const loop = createLink(
      { cable: 'crossover', a: end(sw, 'FastEthernet0/1'), b: end(sw, 'FastEthernet0/1') },
      { ids: linkIds, topology },
    );

    expect(addLink(topology, loop)).toEqual({
      ok: false,
      error: { kind: 'same-port', endpoint: end(sw, 'FastEthernet0/1') },
    });
  });

  it('rejects a link whose id is taken', () => {
    const { topology, pc, sw, server } = buildLab();
    const first = connect(topology, {
      cable: 'straight',
      a: end(pc, 'FastEthernet0'),
      b: end(sw, 'FastEthernet0/1'),
    });
    const clash = {
      id: first.link.id,
      cable: 'straight' as const,
      a: end(server, 'FastEthernet0'),
      b: end(sw, 'FastEthernet0/2'),
    };

    expect(addLink(first.topology, clash)).toEqual({
      ok: false,
      error: { kind: 'duplicate-id', id: first.link.id },
    });
  });
});

describe('removeLinks', () => {
  it('removes the link and frees both ports', () => {
    const { topology, pc, sw, server } = buildLab();
    const first = connect(topology, {
      cable: 'straight',
      a: end(pc, 'FastEthernet0'),
      b: end(sw, 'FastEthernet0/1'),
    });

    const next = removeLinks(first.topology, [first.link.id, LinkId.parse('lnk_missing')]);

    const reuse = createLink(
      { cable: 'straight', a: end(server, 'FastEthernet0'), b: end(sw, 'FastEthernet0/1') },
      { ids: linkIds, topology: next },
    );

    expect(next.links).toEqual({});
    expect(addLink(next, reuse).ok).toBe(true);
  });
});

describe('updateConfig', () => {
  it('replaces the config of a device of the stated kind', () => {
    const { topology, r1 } = buildLab();
    if (r1.kind !== 'router') throw new Error('R1 is not a router');
    const gi00 = port('GigabitEthernet0/0');
    const address = {
      address: Ipv4Address.parse('10.0.0.1'),
      prefixLength: PrefixLength.parse(24),
    };
    const config = {
      ...r1.config,
      interfaces: { ...r1.config.interfaces, [gi00]: { shutdown: false, ipv4: address } },
    };

    const next = expectOk(updateConfig(topology, { device: r1.id, kind: 'router', config }));

    expect(next.devices[r1.id]?.config).toEqual(config);
  });

  it('rejects a config meant for another kind of device', () => {
    const { topology, pc, server } = buildLab();
    if (server.kind !== 'server') throw new Error('Server1 is not a server');

    expect(
      updateConfig(topology, { device: pc.id, kind: 'server', config: server.config }),
    ).toEqual({
      ok: false,
      error: { kind: 'device-kind-mismatch', device: pc.id, expected: 'server', actual: 'pc' },
    });
  });

  it('rejects interface config for a port the device does not have', () => {
    const { topology, r2 } = buildLab();
    if (r2.kind !== 'router') throw new Error('R2 is not a router');
    const config = {
      ...r2.config,
      interfaces: { ...r2.config.interfaces, [port('GigabitEthernet0/7')]: { shutdown: false } },
    };

    expect(updateConfig(topology, { device: r2.id, kind: 'router', config })).toEqual({
      ok: false,
      error: {
        kind: 'interfaces-mismatch',
        device: r2.id,
        missing: [],
        extra: ['GigabitEthernet0/7'],
      },
    });
  });
});

describe('commands', () => {
  it('never change the topology they are given', () => {
    const lab = buildLab();
    const before = structuredClone(lab.topology);

    removeDevices(lab.topology, [lab.pc.id]);
    moveDevices(lab.topology, [{ device: lab.sw.id, position: { x: 9, y: 9 } }]);
    renameDevice(lab.topology, { device: lab.r1.id, hostname: Hostname.parse('Other') });
    connect(lab.topology, {
      cable: 'straight',
      a: end(lab.pc, 'FastEthernet0'),
      b: end(lab.sw, 'FastEthernet0/1'),
    });

    expect(lab.topology).toEqual(before);
  });
});
