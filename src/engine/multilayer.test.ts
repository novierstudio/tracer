import { describe, expect, it } from 'vitest';
import { applyLines, toConfigUpdate, type IosDevice } from '@/cli';
import { updateConfig, type DeviceId, type Topology } from '@/model';
import { expectOk } from '@/model/testing';
import type { PingEvent, TraceEvent } from './api';
import { ms, simTime } from './core/time';
import { createEngine } from './engine';
import type { EventId } from './events';
import { createSimService } from './service';
import { STACKS } from './stacks';
import { ip, labBuilder, staticRoute, STP_CONVERGED } from './testing';

const MULTILAYER = 'switch-l3-24';

/** Configures a router or switch the way a student would, by typing these lines in global config. */
function configure(topology: Topology, id: DeviceId, lines: readonly string[]): Topology {
  const device = topology.devices[id] as IosDevice;
  const { config, errors } = applyLines(device, lines);
  expect(errors).toEqual([]);
  expect(config.unknownLines).toEqual([]);
  return expectOk(updateConfig(topology, toConfigUpdate({ ...device, config } as IosDevice)));
}

/** Loads the lab and runs it to `until`, by default until spanning tree forwards. */
function simulate(topology: Topology, until = STP_CONVERGED) {
  const engine = createEngine({ seed: 1, stacks: STACKS, linkDelay: ms(1) });
  const sim = createSimService({ engine, frames: { now: () => 0, request: () => {} } });
  sim.load(topology);
  engine.runUntil(until);
  const settle = (done: () => boolean) => {
    while (!done() && engine.nextTime() !== undefined) engine.step();
  };
  /** Pings and runs until the summary arrives. Returns each request's fate: who replied, or why not. */
  const ping = (from: DeviceId, target: string, count = 2) => {
    const events: PingEvent[] = [];
    expectOk(sim.ping(from, ip(target), { count, timeoutMs: 1000 }, (e) => events.push(e)));
    settle(() => events.some((e) => e.kind === 'summary'));
    return events.flatMap((e) =>
      e.kind === 'summary' ? [] : [e.kind === 'reply' ? e.from : e.kind],
    );
  };
  /** Each hop of a traceroute as `kind from`, one probe per hop. */
  const traceroute = (from: DeviceId, target: string) => {
    const events: TraceEvent[] = [];
    const options = { maxHops: 5, probesPerHop: 1, timeoutMs: 1000 };
    expectOk(sim.traceroute(from, ip(target), options, (e) => events.push(e)));
    settle(() => events.some((e) => e.kind === 'done'));
    return events.flatMap((e) =>
      e.kind === 'done' ? [] : [`${e.hop} ${e.kind} ${'from' in e ? e.from : ''}`.trim()],
    );
  };
  /** The networks the device has a connected route to, by interface. */
  const connected = (id: DeviceId) =>
    expectOk(sim.routes(id)).flatMap((route) =>
      route.source === 'connected'
        ? [`${route.prefix.address}/${route.prefix.prefixLength} ${route.interface}`]
        : [],
    );
  return { engine, sim, ping, traceroute, connected, settle };
}

const VLANS = [
  'vlan 10',
  'vlan 20',
  'interface FastEthernet0/1',
  ' switchport access vlan 10',
  'interface FastEthernet0/2',
  ' switchport access vlan 20',
  'interface Vlan10',
  ' ip address 192.168.10.1 255.255.255.0',
  'interface Vlan20',
  ' ip address 192.168.20.1 255.255.255.0',
];

/**
 * PC1 192.168.10.10 in VLAN 10 on MLS Fa0/1 and PC2 192.168.20.10 in VLAN 20 on Fa0/2, each with
 * the switch's VLAN interface as its gateway, and no router anywhere.
 */
function interVlan(lines: readonly string[] = ['ip routing', ...VLANS]) {
  const lab = labBuilder();
  const mls = lab.switch('MLS', {}, MULTILAYER);
  const pc1 = lab.host('pc', 'PC1', '192.168.10.10/24', '192.168.10.1');
  const pc2 = lab.host('pc', 'PC2', '192.168.20.10/24', '192.168.20.1');
  lab.connect(pc1, 'FastEthernet0', mls, 'FastEthernet0/1');
  lab.connect(pc2, 'FastEthernet0', mls, 'FastEthernet0/2');
  return { topology: configure(lab.topology, mls, lines), mls, pc1, pc2 };
}

describe('inter-VLAN routing on a multilayer switch', () => {
  it('routes between two VLANs through their VLAN interfaces', () => {
    const { topology, pc1, pc2 } = interVlan();
    const { ping } = simulate(topology);

    expect(ping(pc1, '192.168.20.10')).toEqual(['192.168.20.10', '192.168.20.10']);
    expect(ping(pc2, '192.168.10.10')).toEqual(['192.168.10.10', '192.168.10.10']);
  });

  it('shows its VLAN interface as the one hop on the way', () => {
    const { topology, pc1 } = interVlan();
    const { traceroute } = simulate(topology);

    expect(traceroute(pc1, '192.168.20.10')).toEqual([
      '1 ttl-expired 192.168.10.1',
      '2 reply 192.168.20.10',
    ]);
  });

  it('lists each VLAN interface subnet as connected', () => {
    const { topology, mls } = interVlan();
    const { connected } = simulate(topology);

    expect(connected(mls)).toEqual(['192.168.10.0/24 Vlan10', '192.168.20.0/24 Vlan20']);
  });

  it('routes nothing without ip routing, though each PC still reaches its own VLAN interface', () => {
    const { topology, pc1 } = interVlan(VLANS);
    const { ping } = simulate(topology);

    expect(ping(pc1, '192.168.20.10')).toEqual(['timeout', 'timeout']);
    expect(ping(pc1, '192.168.10.1')).toEqual(['192.168.10.1', '192.168.10.1']);
  });
});

describe('a VLAN interface', () => {
  it('is down while its VLAN does not exist', () => {
    const { topology, mls, pc1 } = interVlan(['ip routing', ...VLANS, 'no vlan 20']);
    const { connected, ping } = simulate(topology);

    expect(connected(mls)).toEqual(['192.168.10.0/24 Vlan10']);
    expect(ping(pc1, '192.168.20.1', 1)).toEqual(['unreachable']);
  });

  it('is down while no port in its VLAN is up', () => {
    const { topology, mls } = interVlan([
      'ip routing',
      ...VLANS,
      'interface FastEthernet0/2',
      ' shutdown',
    ]);
    const { connected } = simulate(topology);

    expect(connected(mls)).toEqual(['192.168.10.0/24 Vlan10']);
  });

  it('stays down until spanning tree forwards a port in its VLAN', () => {
    const { topology, mls } = interVlan();
    const { engine, connected } = simulate(topology, simTime(1000));

    expect(connected(mls)).toEqual([]);
    engine.runUntil(STP_CONVERGED);
    expect(connected(mls)).toEqual(['192.168.10.0/24 Vlan10', '192.168.20.0/24 Vlan20']);
  });

  /**
   * MLS and SW2 joined by two cables in VLAN 1, with SW2 the root, so MLS blocks Fa0/2. PC1
   * 192.168.1.10 sits on SW2, and SW2 floods its ARP request down both cables.
   */
  it('neither listens nor answers on a port spanning tree blocks', () => {
    const lab = labBuilder();
    const mls = lab.switch('MLS', {}, MULTILAYER);
    const sw2 = lab.switch('SW2');
    const pc1 = lab.host('pc', 'PC1', '192.168.1.10/24');
    lab.connect(mls, 'FastEthernet0/1', sw2, 'FastEthernet0/1');
    lab.connect(mls, 'FastEthernet0/2', sw2, 'FastEthernet0/2');
    lab.connect(pc1, 'FastEthernet0', sw2, 'FastEthernet0/3');
    let topology = configure(lab.topology, mls, [
      'interface Vlan1',
      ' ip address 192.168.1.1 255.255.255.0',
      ' no shutdown',
    ]);
    topology = configure(topology, sw2, ['spanning-tree vlan 1 priority 4096']);
    const { engine, sim, ping } = simulate(topology);
    const blocked = expectOk(sim.spanningTree(mls))[0]!.ports.find(
      (port) => port.port === 'FastEthernet0/2',
    );
    expect(blocked?.state).toBe('blocking');
    const start = engine.log.lastId;

    expect(ping(pc1, '192.168.1.1')).toEqual(['192.168.1.1', '192.168.1.1']);
    const outOfBlocked = [...engine.log.since(start)].filter(
      (event) =>
        event.kind === 'frame' &&
        event.from.device === mls &&
        event.from.port === 'FastEthernet0/2' &&
        event.frame.kind === 'ethernet' &&
        event.frame.payload.kind !== 'bpdu',
    );
    expect(outOfBlocked).toEqual([]);
  });
});

/**
 * PC1 in VLAN 10 and PC2, a DHCP client, in VLAN 20 on MLS. MLS's Gi0/1 is a routed port,
 * 10.0.0.1/30, to R1's Gi0/0 at 10.0.0.2. R1 has a loopback, 1.1.1.1, and lends VLAN 20's
 * addresses, which MLS relays to it.
 */
function routedUplink() {
  const lab = labBuilder();
  const mls = lab.switch('MLS', {}, MULTILAYER);
  const r1 = lab.router('R1', { 'GigabitEthernet0/0': '10.0.0.2/30', Loopback0: '1.1.1.1/32' }, [
    staticRoute('192.168.0.0/16', '10.0.0.1'),
  ]);
  const pc1 = lab.host('pc', 'PC1', '192.168.10.10/24', '192.168.10.1');
  const pc2 = lab.dhcpHost('pc', 'PC2');
  lab.connect(pc1, 'FastEthernet0', mls, 'FastEthernet0/1');
  lab.connect(pc2, 'FastEthernet0', mls, 'FastEthernet0/2');
  lab.connect(mls, 'GigabitEthernet0/1', r1, 'GigabitEthernet0/0');
  let topology = configure(lab.topology, mls, [
    'ip routing',
    ...VLANS,
    'interface Vlan20',
    ' ip helper-address 10.0.0.2',
    'interface GigabitEthernet0/1',
    ' no switchport',
    ' ip address 10.0.0.1 255.255.255.252',
    'exit',
    'ip route 0.0.0.0 0.0.0.0 10.0.0.2',
  ]);
  topology = configure(topology, r1, [
    'ip dhcp excluded-address 192.168.20.1',
    'ip dhcp pool VLAN20',
    ' network 192.168.20.0 255.255.255.0',
    ' default-router 192.168.20.1',
  ]);
  return { topology, mls, r1, pc1, pc2 };
}

describe('a routed port on a multilayer switch', () => {
  it('routes to a router beyond it by a static route', () => {
    const { topology, mls, pc1 } = routedUplink();
    const { ping, connected } = simulate(topology);

    expect(connected(mls)).toContain('10.0.0.0/30 GigabitEthernet0/1');
    expect(ping(pc1, '1.1.1.1')).toEqual(['1.1.1.1', '1.1.1.1']);
  });

  it('takes no part in switching or spanning tree', () => {
    const { topology, mls } = routedUplink();
    const { engine, sim } = simulate(topology);

    const bpdus = [...engine.log.since(0 as EventId)].filter(
      (event) =>
        event.kind === 'frame' &&
        event.from.device === mls &&
        event.from.port === 'GigabitEthernet0/1' &&
        event.frame.kind === 'ethernet' &&
        event.frame.payload.kind === 'bpdu',
    );
    expect(bpdus).toEqual([]);
    const tree = expectOk(sim.spanningTree(mls));
    expect(tree.flatMap((vlan) => vlan.ports.map((port) => port.port))).not.toContain(
      'GigabitEthernet0/1',
    );
  });

  it('relays DHCP from a VLAN interface with a helper address', () => {
    const { topology, pc2 } = routedUplink();
    const { sim, settle } = simulate(topology);

    const leased = () => {
      const addressing = sim.hostIp(pc2);
      return addressing.ok && addressing.value.kind === 'leased';
    };
    settle(leased);
    expect(expectOk(sim.hostIp(pc2))).toMatchObject({
      kind: 'leased',
      address: { address: '192.168.20.2', prefixLength: 24 },
      gateway: '192.168.20.1',
    });
  });
});
