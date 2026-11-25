import { describe, expect, it } from 'vitest';
import {
  addLink,
  createLink,
  Hostname,
  moveDevices,
  removeDevices,
  renameDevice,
  type Topology,
} from '@/model';
import { buildLab, end, expectOk } from '@/model/testing';
import { diffTopology } from './patch';

function linked() {
  const lab = buildLab();
  const link = createLink(
    { cable: 'straight', a: end(lab.pc, 'FastEthernet0'), b: end(lab.sw, 'FastEthernet0/1') },
    { ids: lab.ids, topology: lab.topology },
  );
  return { ...lab, link, topology: expectOk(addLink(lab.topology, link)) };
}

describe('diffTopology', () => {
  it('finds nothing between a topology and itself', () => {
    const { topology } = linked();
    expect(diffTopology(topology, topology)).toBeUndefined();
  });

  it('ignores moves, which the simulation cannot see', () => {
    const { topology, pc, sw } = linked();
    const moved = moveDevices(topology, [
      { device: pc.id, position: { x: 40, y: 80 } },
      { device: sw.id, position: { x: 1, y: 2 } },
    ]);
    expect(diffTopology(topology, moved)).toBeUndefined();
  });

  it('carries the new value of a device whose config changed', () => {
    const { topology, sw } = linked();
    const renamed = expectOk(
      renameDevice(topology, { device: sw.id, hostname: Hostname.parse('Core') }),
    );
    expect(diffTopology(topology, renamed)).toEqual({
      devices: { [sw.id]: renamed.devices[sw.id] },
      links: {},
    });
  });

  it('carries added links, and null for removed devices and their links', () => {
    const { topology, pc, link } = linked();
    const before = { ...topology, links: {} } as Topology;
    expect(diffTopology(before, topology)).toEqual({ devices: {}, links: { [link.id]: link } });

    const removed = removeDevices(topology, [pc.id]);
    expect(diffTopology(topology, removed)).toEqual({
      devices: { [pc.id]: null },
      links: { [link.id]: null },
    });
  });
});
