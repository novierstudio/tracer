import { describe, expect, it } from 'vitest';
import {
  IOS_SOFTWARE,
  PortId,
  VirtualInterfaceId,
  type Device,
  type DeviceId,
  type LinkId,
  type Topology,
} from '@/model';
import { after, ms } from '../core/time';
import { createEngine } from '../engine';
import { createSimService } from '../service';
import { STACKS } from '../stacks';
import { cidr, labBuilder, trunk } from '../testing';

type IosDevice = Extract<Device, { kind: 'router' | 'switch' }>;

const port = (name: string) => PortId.parse(name);

/**
 * R1 between two switches, Gi0/0 to SW1's Gi0/1 and Gi0/1 to SW2's Gi0/1, the switches joined
 * Fa0/1 to Fa0/1 on a trunk, and R2 on R1's Serial0/0/0. SW1 has 192.168.1.2 on VLAN 1.
 */
function discoveryLab() {
  const lab = labBuilder();
  const r1 = lab.router('R1', {
    'GigabitEthernet0/0': '192.168.1.1/24',
    'GigabitEthernet0/1': '192.168.2.1/24',
    'Serial0/0/0': '10.0.0.1/30',
  });
  const r2 = lab.router('R2', { 'Serial0/0/0': '10.0.0.2/30' });
  const sw1 = lab.switch('SW1', { 'FastEthernet0/1': trunk() });
  const sw2 = lab.switch('SW2', { 'FastEthernet0/1': trunk() });
  lab.edit(sw1, (device) => {
    const copy = structuredClone(device) as IosDevice;
    copy.config.virtualInterfaces[VirtualInterfaceId.parse('Vlan1')] = {
      shutdown: false,
      ipv4: cidr('192.168.1.2/24'),
    };
    return copy;
  });
  lab.connect(r1, 'GigabitEthernet0/0', sw1, 'GigabitEthernet0/1');
  lab.connect(r1, 'GigabitEthernet0/1', sw2, 'GigabitEthernet0/1');
  lab.connect(sw1, 'FastEthernet0/1', sw2, 'FastEthernet0/1');
  lab.connect(r1, 'Serial0/0/0', r2, 'Serial0/0/0');

  let topology = lab.topology;
  const engine = createEngine({ seed: 1, stacks: STACKS, linkDelay: ms(1) });
  const sim = createSimService({ engine, frames: { now: () => 0, request: () => {} } });
  sim.load(topology);
  const runFor = (millis: number) => engine.runUntil(after(engine.now, ms(millis)));

  const status = (id: DeviceId) => {
    const result = sim.layer2Status(id);
    if (!result.ok) throw new Error(result.error);
    return result.value;
  };
  /** Each CDP neighbour as `local port: device ID on its port`. */
  const cdp = (id: DeviceId) =>
    status(id).cdp.neighbors.map((n) => `${n.localPort}: ${n.deviceId} on ${n.portId}`);
  const lldp = (id: DeviceId) =>
    status(id).lldp.neighbors.map((n) => `${n.localPort}: ${n.systemName} on ${n.portId}`);
  /** Changes a device's config, as committing a console line does. */
  const configure = (id: DeviceId, edit: (device: IosDevice) => void) => {
    const copy = structuredClone(topology.devices[id]) as IosDevice;
    edit(copy);
    topology = { ...topology, devices: { ...topology.devices, [id]: copy } };
    sim.applyPatch({ devices: { [id]: copy }, links: {} });
  };
  const unplug = (a: DeviceId, aPort: string) => {
    const link = Object.values(topology.links).find(
      (candidate) => candidate.a.device === a && candidate.a.port === aPort,
    )!;
    const links = { ...topology.links } as Topology['links'];
    delete links[link.id];
    topology = { ...topology, links };
    sim.applyPatch({ devices: {}, links: { [link.id as LinkId]: null } });
  };
  const mac = (id: DeviceId, name: string) => {
    const hardware = topology.devices[id]!.ports.find((candidate) => candidate.id === name);
    return hardware?.kind === 'serial' ? undefined : hardware?.mac;
  };
  return { r1, r2, sw1, sw2, runFor, status, cdp, lldp, configure, unplug, mac };
}

describe('CDP', () => {
  it('finds each neighbour on the port that faces it, Ethernet and serial alike', () => {
    const lab = discoveryLab();
    lab.runFor(1000);

    expect(lab.cdp(lab.r1)).toEqual([
      'GigabitEthernet0/0: SW1 on GigabitEthernet0/1',
      'GigabitEthernet0/1: SW2 on GigabitEthernet0/1',
      'Serial0/0/0: R2 on Serial0/0/0',
    ]);
    expect(lab.cdp(lab.sw1)).toEqual([
      'FastEthernet0/1: SW2 on FastEthernet0/1',
      'GigabitEthernet0/1: R1 on GigabitEthernet0/0',
    ]);
    expect(lab.cdp(lab.sw2)).toEqual([
      'FastEthernet0/1: SW1 on FastEthernet0/1',
      'GigabitEthernet0/1: R1 on GigabitEthernet0/1',
    ]);
    expect(lab.cdp(lab.r2)).toEqual(['Serial0/0/0: R1 on Serial0/0/0']);
  });

  it('learns what each neighbour is: capabilities, platform, address, software and VLAN', () => {
    const lab = discoveryLab();
    lab.runFor(1000);
    const [fromSw1] = lab.status(lab.r1).cdp.neighbors;
    const fromR1 = lab.status(lab.sw1).cdp.neighbors.find((n) => n.deviceId === 'R1');

    expect(fromSw1).toEqual({
      deviceId: 'SW1',
      localPort: port('GigabitEthernet0/0'),
      holdtime: 180,
      capabilities: ['switch'],
      platform: 'switch',
      portId: 'GigabitEthernet0/1',
      // A switch advertises its VLAN interface's address.
      addresses: ['192.168.1.2'],
      software: IOS_SOFTWARE,
      version: 2,
      nativeVlan: 1,
      duplex: 'full',
    });
    expect(fromR1).toMatchObject({
      capabilities: ['router'],
      platform: 'router',
      addresses: ['192.168.1.1'],
    });
    expect(fromR1).not.toHaveProperty('nativeVlan');
  });

  it('calls a multilayer switch with ip routing a router and a switch', () => {
    const lab = discoveryLab();
    lab.configure(lab.sw1, (device) => {
      if (device.kind === 'switch') device.config.ipRouting = true;
    });
    lab.runFor(6000);

    const fromSw1 = lab.status(lab.r1).cdp.neighbors.find((n) => n.deviceId === 'SW1');
    expect(fromSw1?.capabilities).toEqual(['router', 'switch']);
  });

  it('counts the holdtime down once the far end goes quiet, then forgets it', () => {
    const lab = discoveryLab();
    lab.runFor(1000);
    lab.configure(lab.sw1, (device) => void (device.config.cdpRun = false));
    const holdtime = () =>
      lab.status(lab.r1).cdp.neighbors.find((n) => n.deviceId === 'SW1')?.holdtime;
    // SW1's last advertisement arrived at 1 ms, so its 180 s run out at 180.001 s.
    expect(holdtime()).toBe(180);

    lab.runFor(60_000);
    expect(holdtime()).toBe(120);
    lab.runFor(119_000);
    expect(holdtime()).toBe(1);
    lab.runFor(1);
    expect(holdtime()).toBeUndefined();
    expect(lab.cdp(lab.sw1)).toEqual([]);
  });

  it('keeps a neighbour as long as it advertises', () => {
    const lab = discoveryLab();
    lab.runFor(600_000);

    expect(lab.cdp(lab.r1)).toHaveLength(3);
    // Fast timers send every 5 s, so the entry never falls below 175 s.
    for (const neighbor of lab.status(lab.r1).cdp.neighbors) {
      expect(neighbor.holdtime).toBeGreaterThanOrEqual(175);
    }
  });

  it('forgets the neighbours on a port at once when its link goes down', () => {
    const lab = discoveryLab();
    lab.runFor(1000);
    lab.unplug(lab.r1, 'GigabitEthernet0/0');

    expect(lab.cdp(lab.r1)).toEqual([
      'GigabitEthernet0/1: SW2 on GigabitEthernet0/1',
      'Serial0/0/0: R2 on Serial0/0/0',
    ]);
    expect(lab.cdp(lab.sw1)).toEqual(['FastEthernet0/1: SW2 on FastEthernet0/1']);
  });

  it('neither sends nor listens on a port with no cdp enable', () => {
    const lab = discoveryLab();
    lab.configure(lab.r1, (device) => {
      device.config.interfaces[port('GigabitEthernet0/0')]!.cdpEnable = false;
    });
    lab.runFor(1000);

    expect(lab.cdp(lab.r1)).toEqual([
      'GigabitEthernet0/1: SW2 on GigabitEthernet0/1',
      'Serial0/0/0: R2 on Serial0/0/0',
    ]);
    expect(lab.cdp(lab.sw1)).toEqual(['FastEthernet0/1: SW2 on FastEthernet0/1']);
    expect(lab.status(lab.r1).cdp.interfaces).not.toContain('GigabitEthernet0/0');
  });

  it('advertises at once when cdp enable comes back', () => {
    const lab = discoveryLab();
    lab.configure(lab.r1, (device) => {
      device.config.interfaces[port('GigabitEthernet0/0')]!.cdpEnable = false;
    });
    lab.runFor(1000);
    lab.configure(lab.r1, (device) => {
      delete device.config.interfaces[port('GigabitEthernet0/0')]!.cdpEnable;
    });
    lab.runFor(10);

    expect(lab.cdp(lab.sw1)).toContain('GigabitEthernet0/1: R1 on GigabitEthernet0/0');
  });

  it('advertises the holdtime and timer the config sets', () => {
    const lab = discoveryLab();
    lab.configure(lab.sw1, (device) => {
      device.config.cdpTimer = 30;
      device.config.cdpHoldtime = 90;
    });
    lab.runFor(1000);

    const fromSw1 = lab.status(lab.r1).cdp.neighbors.find((n) => n.deviceId === 'SW1');
    expect(fromSw1?.holdtime).toBe(90);
    expect(lab.status(lab.sw1).cdp).toMatchObject({ enabled: true, timer: 30, holdtime: 90 });
    // With a timer set, SW1 waits 30 s between advertisements even on the fast timers.
    lab.runFor(28_000);
    expect(lab.status(lab.r1).cdp.neighbors.find((n) => n.deviceId === 'SW1')?.holdtime).toBe(62);
    lab.runFor(2_000);
    expect(lab.status(lab.r1).cdp.neighbors.find((n) => n.deviceId === 'SW1')?.holdtime).toBe(90);
  });
});

describe('LLDP', () => {
  it('stays off until lldp run, then finds the neighbours that run it too', () => {
    const lab = discoveryLab();
    lab.runFor(1000);
    expect(lab.status(lab.r1).lldp.enabled).toBe(false);
    expect(lab.lldp(lab.r1)).toEqual([]);

    for (const id of [lab.r1, lab.sw1]) {
      lab.configure(id, (device) => void (device.config.lldpRun = true));
    }
    lab.runFor(10);

    // LLDP runs on Ethernet only, and SW2 and R2 still have it off.
    expect(lab.lldp(lab.r1)).toEqual(['GigabitEthernet0/0: SW1 on GigabitEthernet0/1']);
    expect(lab.lldp(lab.sw1)).toEqual(['GigabitEthernet0/1: R1 on GigabitEthernet0/0']);
    const [fromSw1] = lab.status(lab.r1).lldp.neighbors;
    expect(fromSw1).toEqual({
      chassisId: lab.mac(lab.sw1, 'GigabitEthernet0/1'),
      localPort: port('GigabitEthernet0/0'),
      holdtime: 120,
      ttl: 120,
      portId: 'GigabitEthernet0/1',
      systemName: 'SW1',
      systemDescription: IOS_SOFTWARE,
      capabilities: ['switch'],
      vlan: 1,
    });
  });

  it('keeps nothing heard on a port with no lldp receive', () => {
    const lab = discoveryLab();
    for (const id of [lab.r1, lab.sw1]) {
      lab.configure(id, (device) => void (device.config.lldpRun = true));
    }
    lab.configure(lab.r1, (device) => {
      device.config.interfaces[port('GigabitEthernet0/0')]!.lldpReceive = false;
    });
    lab.runFor(1000);

    expect(lab.lldp(lab.r1)).toEqual([]);
    expect(lab.lldp(lab.sw1)).toEqual(['GigabitEthernet0/1: R1 on GigabitEthernet0/0']);
  });

  it('forgets every neighbour when lldp run goes', () => {
    const lab = discoveryLab();
    for (const id of [lab.r1, lab.sw1]) {
      lab.configure(id, (device) => void (device.config.lldpRun = true));
    }
    lab.runFor(1000);
    lab.configure(lab.r1, (device) => void delete device.config.lldpRun);

    expect(lab.lldp(lab.r1)).toEqual([]);
  });
});
