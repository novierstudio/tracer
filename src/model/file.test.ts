// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { addLink, createLink, updateConfig, type LinkSpec } from './commands';
import { parseTopology, parseTopologyJson, serializeTopology } from './file';
import { AnnotationId } from './ids';
import { buildLab, end, expectOk, port } from './testing';
import type { Topology } from './topology';
import { Ipv4Address, PrefixLength, VlanId } from './values';

function richLab() {
  const lab = buildLab();
  let topology = lab.topology;
  const { r1, r2, sw, pc, server } = lab;
  if (r1.kind !== 'router' || sw.kind !== 'switch' || pc.kind !== 'pc') {
    throw new Error('Unexpected lab devices');
  }
  const connect = (spec: LinkSpec) => {
    topology = expectOk(addLink(topology, createLink(spec, { ids: lab.ids, topology })));
  };

  connect({ cable: 'serial', a: end(r1, 'Serial0/0/0'), b: end(r2, 'Serial0/0/0'), dce: 'b' });
  connect({
    cable: 'straight',
    a: end(r1, 'GigabitEthernet0/0'),
    b: end(sw, 'GigabitEthernet0/1'),
  });
  connect({ cable: 'straight', a: end(sw, 'FastEthernet0/1'), b: end(pc, 'FastEthernet0') });
  connect({ cable: 'straight', a: end(sw, 'FastEthernet0/2'), b: end(server, 'FastEthernet0') });

  const vlan10 = VlanId.parse(10);
  topology = expectOk(
    updateConfig(topology, {
      device: r1.id,
      kind: 'router',
      config: {
        ...r1.config,
        interfaces: {
          ...r1.config.interfaces,
          [port('GigabitEthernet0/0')]: {
            shutdown: false,
            description: 'LAN',
            ipv4: {
              address: Ipv4Address.parse('192.168.10.1'),
              prefixLength: PrefixLength.parse(24),
            },
          },
        },
        unknownLines: ['service timestamps debug datetime msec'],
      },
    }),
  );
  topology = expectOk(
    updateConfig(topology, {
      device: sw.id,
      kind: 'switch',
      config: {
        ...sw.config,
        interfaces: {
          ...sw.config.interfaces,
          [port('GigabitEthernet0/1')]: {
            shutdown: false,
            switchport: { mode: 'trunk', nativeVlan: VlanId.parse(1) },
          },
          [port('FastEthernet0/1')]: {
            shutdown: false,
            switchport: { mode: 'access', vlan: vlan10 },
          },
        },
        vlans: { ...sw.config.vlans, [vlan10]: { name: 'Staff' } },
      },
    }),
  );
  topology = expectOk(
    updateConfig(topology, {
      device: pc.id,
      kind: 'pc',
      config: {
        ...pc.config,
        ipv4: {
          mode: 'static',
          address: {
            address: Ipv4Address.parse('192.168.10.20'),
            prefixLength: PrefixLength.parse(24),
          },
          gateway: Ipv4Address.parse('192.168.10.1'),
          dns: Ipv4Address.parse('192.168.10.5'),
        },
      },
    }),
  );
  const note = AnnotationId.parse('ann_note1');
  topology = {
    ...topology,
    annotations: { [note]: { id: note, kind: 'note', position: { x: 5, y: 5 }, text: 'Core' } },
  };

  return { ...lab, topology };
}

function reparse(document: unknown) {
  return parseTopology(JSON.parse(JSON.stringify(document)));
}

describe('topology files', () => {
  it('read back exactly what was written', () => {
    const { topology } = richLab();

    const text = serializeTopology(topology);

    expect(JSON.parse(text)).toMatchObject({ version: 1 });
    expect(expectOk(parseTopologyJson(text))).toEqual(topology);
  });

  it('fill the IOS fields that files written before they existed lack', () => {
    const { topology, r1, sw } = richLab();
    const document = JSON.parse(serializeTopology(topology));
    const added = [
      'virtualInterfaces',
      'servicePasswordEncryption',
      'domainLookup',
      'lines',
      'staticRoutes',
    ];
    for (const id of [r1.id, sw.id]) {
      for (const field of added) delete document.devices[id].config[field];
    }

    const read = expectOk(parseTopology(document));

    const router = read.devices[r1.id];
    const routerConfig = router?.kind === 'router' ? router.config : undefined;
    expect(routerConfig).toMatchObject({
      virtualInterfaces: {},
      servicePasswordEncryption: false,
      domainLookup: true,
      staticRoutes: [],
    });
    expect(routerConfig?.lines.aux.login).toBe('none');
    expect(routerConfig?.lines.vty).toHaveLength(16);
    const switchDevice = read.devices[sw.id];
    expect(switchDevice?.kind === 'switch' && Object.keys(switchDevice.config.lines)).toEqual([
      'console',
      'vty',
    ]);
  });

  it('report text that is not JSON', () => {
    const result = parseTopologyJson('{"version": 1,');

    expect(result.ok || result.error.kind).toBe('invalid-json');
  });

  it('report a document without a version', () => {
    const { topology } = richLab();
    const unversioned: Partial<Topology> = { ...topology };
    delete unversioned.version;

    expect(reparse(unversioned)).toMatchObject({
      ok: false,
      error: { kind: 'unsupported-version', message: expect.stringMatching(/no version/) },
    });
  });

  it.each([0, 2])('report version %i as unsupported, naming both versions', (version) => {
    const { topology } = richLab();

    expect(reparse({ ...topology, version })).toEqual({
      ok: false,
      error: {
        kind: 'unsupported-version',
        version,
        message: `This topology is version ${version}, and this build of Tracer reads version 1`,
      },
    });
  });

  it('point at the field holding a malformed value', () => {
    const { topology, r1 } = richLab();
    const text = serializeTopology(topology).replace('"192.168.10.1"', '"192.168.10.300"');

    const result = parseTopologyJson(text);

    expect(result.ok || result.error.kind).toBe('invalid-topology');
    expect(result.ok || result.error.message).toContain(
      `✖ Invalid IPv4 address\n  → at devices.${r1.id}.config.interfaces["GigabitEthernet0/0"].ipv4.address`,
    );
  });

  it('reject two links on the same port and name the link that already holds it', () => {
    const { topology, sw, pc } = richLab();
    const [heldBy] = Object.values(topology.links).filter((link) => link.b.device === pc.id);
    if (!heldBy) throw new Error('PC is not connected in the fixture');
    const clash = {
      id: 'lnk_clash',
      cable: 'straight',
      a: { device: sw.id, port: 'FastEthernet0/1' },
      b: { device: pc.id, port: 'FastEthernet0' },
    };

    const result = reparse({ ...topology, links: { ...topology.links, lnk_clash: clash } });

    expect(result.ok || result.error.message).toContain(
      `Port FastEthernet0/1 on device ${sw.id} is already connected by link ${heldBy.id}`,
    );
    expect(result.ok || result.error.message).toContain('links.lnk_clash');
  });

  it('reject a link to a device that is not in the file', () => {
    const { topology, pc } = richLab();
    const devices: Partial<Topology['devices']> = { ...topology.devices };
    delete devices[pc.id];

    const result = reparse({ ...topology, devices });

    expect(result.ok || result.error.message).toContain(`Device ${pc.id} does not exist`);
  });

  it('reject a device filed under a key that is not its id', () => {
    const { topology, pc } = richLab();
    const devices: Record<string, unknown> = { ...topology.devices, dev_elsewhere: pc };
    delete devices[pc.id];

    const result = reparse({ ...topology, devices, links: {} });

    expect(result.ok || result.error.message).toContain(
      `Key dev_elsewhere does not match id ${pc.id}`,
    );
  });

  it('reject router interface config that does not match its ports', () => {
    const { topology, r2 } = richLab();
    if (r2.kind !== 'router') throw new Error('R2 is not a router');
    const broken = { ...r2, config: { ...r2.config, interfaces: {} } };

    const result = reparse({ ...topology, devices: { ...topology.devices, [r2.id]: broken } });

    expect(result.ok || result.error.message).toContain(
      `Interface config on device ${r2.id} must cover exactly its ports (missing GigabitEthernet0/0, Serial0/0/0)`,
    );
  });
});
