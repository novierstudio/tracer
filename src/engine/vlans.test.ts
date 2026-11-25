import { describe, expect, it } from 'vitest';
import { applyLines, toConfigUpdate, type IosDevice } from '@/cli';
import { updateConfig, type DeviceId, type Topology } from '@/model';
import { expectOk } from '@/model/testing';
import type { PingEvent } from './api';
import { ms } from './core/time';
import { createEngine, type Engine } from './engine';
import type { EventId } from './events';
import { createSimService } from './service';
import { STACKS } from './stacks';
import { ip, labBuilder, STP_CONVERGED } from './testing';

/** Configures a router or switch the way a student would, by typing these lines in global config. */
function configure(topology: Topology, id: DeviceId, lines: readonly string[]): Topology {
  const device = topology.devices[id] as IosDevice;
  const { config, errors } = applyLines(device, lines);
  expect(errors).toEqual([]);
  expect(config.unknownLines).toEqual([]);
  return expectOk(updateConfig(topology, toConfigUpdate({ ...device, config } as IosDevice)));
}

function simulate(topology: Topology) {
  const engine = createEngine({ seed: 1, stacks: STACKS, linkDelay: ms(1) });
  const sim = createSimService({ engine, frames: { now: () => 0, request: () => {} } });
  sim.load(topology);
  engine.runUntil(STP_CONVERGED);
  /** Pings and runs the simulation until the summary arrives. Returns the replies' sources. */
  const ping = (from: DeviceId, target: string, count = 2) => {
    const events: PingEvent[] = [];
    const started = sim.ping(from, ip(target), { count, timeoutMs: 1000 }, (e) => events.push(e));
    if (!started.ok) throw new Error(started.error);
    while (!events.some((e) => e.kind === 'summary') && engine.nextTime() !== undefined) {
      engine.step();
    }
    return events.map((event): string => (event.kind === 'reply' ? event.from : event.kind));
  };
  const value = <T>(result: { ok: true; value: T } | { ok: false; error: string }): T => {
    if (!result.ok) throw new Error(result.error);
    return result.value;
  };
  return { engine, sim, ping, value };
}

/** The VLAN tag of every Ethernet frame but BPDUs delivered across the cable between two devices. */
function tagsBetween(engine: Engine, a: DeviceId, b: DeviceId) {
  const tags = new Set<number | 'untagged'>();
  for (const event of engine.log.since(0 as EventId)) {
    if (event.kind !== 'frame' || event.frame.kind !== 'ethernet') continue;
    if (event.frame.payload.kind === 'bpdu') continue;
    const ends = [event.from.device, event.to.device];
    if (ends.includes(a) && ends.includes(b)) tags.add(event.frame.tag?.vlan ?? 'untagged');
  }
  return [...tags].sort();
}

const SWITCH_VLANS = [
  'vlan 10',
  ' name Sales',
  'vlan 20',
  ' name Staff',
  'interface FastEthernet0/1',
  ' switchport mode access',
  ' switchport access vlan 10',
  'interface FastEthernet0/2',
  ' switchport mode access',
  ' switchport access vlan 20',
];

const ROUTER_ON_A_STICK = [
  'hostname R1',
  'interface GigabitEthernet0/0',
  ' no shutdown',
  'interface GigabitEthernet0/0.10',
  ' encapsulation dot1Q 10',
  ' ip address 192.168.10.1 255.255.255.0',
  'interface GigabitEthernet0/0.20',
  ' encapsulation dot1Q 20',
  ' ip address 192.168.20.1 255.255.255.0',
];

/**
 * PC1 192.168.10.10 in VLAN 10 on SW1 Fa0/1, PC2 192.168.20.10 in VLAN 20 on Fa0/2, and R1 on a
 * trunk from SW1 Gi0/1 to its Gi0/0, routing between the VLANs on two subinterfaces.
 */
function routerOnAStick({ router = [] as string[], switch: extra = [] as string[] } = {}) {
  const lab = labBuilder();
  const sw1 = lab.switch('SW1');
  const r1 = lab.router('R1', {});
  const pc1 = lab.host('pc', 'PC1', '192.168.10.10/24', '192.168.10.1');
  const pc2 = lab.host('pc', 'PC2', '192.168.20.10/24', '192.168.20.1');
  lab.connect(pc1, 'FastEthernet0', sw1, 'FastEthernet0/1');
  lab.connect(pc2, 'FastEthernet0', sw1, 'FastEthernet0/2');
  lab.connect(sw1, 'GigabitEthernet0/1', r1, 'GigabitEthernet0/0');
  let topology = configure(lab.topology, r1, [...ROUTER_ON_A_STICK, ...router]);
  topology = configure(topology, sw1, [
    ...SWITCH_VLANS,
    'interface GigabitEthernet0/1',
    ' switchport mode trunk',
    ...extra,
  ]);
  return { topology, sw1, r1, pc1, pc2 };
}

describe('VLANs on one switch', () => {
  function sameSubnet(secondVlan: number) {
    const lab = labBuilder();
    const sw1 = lab.switch('SW1');
    const pc1 = lab.host('pc', 'PC1', '192.168.1.10/24');
    const pc2 = lab.host('pc', 'PC2', '192.168.1.20/24');
    lab.connect(pc1, 'FastEthernet0', sw1, 'FastEthernet0/1');
    lab.connect(pc2, 'FastEthernet0', sw1, 'FastEthernet0/2');
    const topology = configure(lab.topology, sw1, [
      'interface FastEthernet0/1',
      ' switchport access vlan 10',
      'interface FastEthernet0/2',
      ` switchport access vlan ${secondVlan}`,
    ]);
    return { ...simulate(topology), pc1 };
  }

  it('cannot ping between two VLANs without a router, even in one subnet', () => {
    const { ping, pc1 } = sameSubnet(20);

    expect(ping(pc1, '192.168.1.20')).toEqual(['timeout', 'timeout', 'summary']);
  });

  it('pings within one VLAN', () => {
    const { ping, pc1 } = sameSubnet(10);

    expect(ping(pc1, '192.168.1.20')).toEqual(['192.168.1.20', '192.168.1.20', 'summary']);
  });
});

describe('router-on-a-stick', () => {
  it('routes a ping from VLAN 10 to VLAN 20 through two subinterfaces, tagged on the trunk', () => {
    const { topology, sw1, r1, pc1 } = routerOnAStick();
    const { engine, ping } = simulate(topology);

    expect(ping(pc1, '192.168.20.10')).toEqual(['192.168.20.10', '192.168.20.10', 'summary']);
    expect(tagsBetween(engine, sw1, r1)).toEqual([10, 20]);
  });

  it('answers the router, switch and host queries the show commands read', () => {
    const { topology, sw1, r1, pc1 } = routerOnAStick();
    const { sim, ping, value } = simulate(topology);
    ping(pc1, '192.168.20.10');
    const routerMac = (topology.devices[r1]!.ports[0] as { mac: string }).mac;

    expect(value(sim.routes(r1))).toEqual([
      expect.objectContaining({ source: 'connected', interface: 'GigabitEthernet0/0.10' }),
      expect.objectContaining({ source: 'local', interface: 'GigabitEthernet0/0.10' }),
      expect.objectContaining({ source: 'connected', interface: 'GigabitEthernet0/0.20' }),
      expect.objectContaining({ source: 'local', interface: 'GigabitEthernet0/0.20' }),
    ]);
    expect(
      value(sim.arpTable(r1)).map((entry) => [entry.kind, entry.address, entry.interface]),
    ).toEqual([
      ['interface', '192.168.10.1', 'GigabitEthernet0/0.10'],
      ['dynamic', '192.168.10.10', 'GigabitEthernet0/0.10'],
      ['interface', '192.168.20.1', 'GigabitEthernet0/0.20'],
      ['dynamic', '192.168.20.10', 'GigabitEthernet0/0.20'],
    ]);
    const learned = value(sim.macTable(sw1)).filter((entry) => entry.mac === routerMac);
    expect(learned.map(({ vlan, port }) => [vlan, port])).toEqual([
      [10, 'GigabitEthernet0/1'],
      [20, 'GigabitEthernet0/1'],
    ]);
    expect(value(sim.portStates(sw1))).toMatchObject({
      'FastEthernet0/1': true,
      'FastEthernet0/3': false,
      'GigabitEthernet0/1': true,
    });
  });

  it('carries the native VLAN untagged when both ends agree on it', () => {
    const { topology, sw1, r1, pc1 } = routerOnAStick({
      router: ['interface GigabitEthernet0/0.10', ' encapsulation dot1Q 10 native'],
      switch: ['interface GigabitEthernet0/1', ' switchport trunk native vlan 10'],
    });
    const { engine, ping } = simulate(topology);

    expect(ping(pc1, '192.168.20.10')).toEqual(['192.168.20.10', '192.168.20.10', 'summary']);
    expect(tagsBetween(engine, sw1, r1)).toEqual([20, 'untagged']);
  });

  it('cannot reach a VLAN the trunk does not allow', () => {
    const { topology, pc1, pc2 } = routerOnAStick({
      switch: ['interface GigabitEthernet0/1', ' switchport trunk allowed vlan 1,10'],
    });
    const { ping } = simulate(topology);

    expect(ping(pc1, '192.168.10.1')).toEqual(['192.168.10.1', '192.168.10.1', 'summary']);
    expect(ping(pc1, '192.168.20.10')).toEqual(['timeout', 'timeout', 'summary']);
    expect(ping(pc2, '192.168.20.1')).toEqual(['timeout', 'timeout', 'summary']);
  });
});

describe("a switch's management interface", () => {
  it('answers pings in its VLAN, and from other VLANs through its default gateway', () => {
    const { topology, pc1, pc2 } = routerOnAStick({
      switch: [
        'interface Vlan10',
        ' ip address 192.168.10.2 255.255.255.0',
        ' no shutdown',
        'ip default-gateway 192.168.10.1',
      ],
    });
    const { ping } = simulate(topology);

    expect(ping(pc1, '192.168.10.2')).toEqual(['192.168.10.2', '192.168.10.2', 'summary']);
    expect(ping(pc2, '192.168.10.2')).toEqual(['192.168.10.2', '192.168.10.2', 'summary']);
  });

  it('stays silent while it is shut down', () => {
    const { topology, pc1 } = routerOnAStick({
      switch: ['interface Vlan10', ' ip address 192.168.10.2 255.255.255.0', ' shutdown'],
    });
    const { ping } = simulate(topology);

    expect(ping(pc1, '192.168.10.2')).toEqual(['timeout', 'timeout', 'summary']);
  });
});
