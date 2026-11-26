import { describe, expect, it } from 'vitest';
import type { Device, DeviceId, EigrpConfig, RoutedInterface, Topology } from '@/model';
import type { EigrpStatus, PingEvent, Route } from '../../api';
import { ms, simTime } from '../../core/time';
import { createEngine } from '../../engine';
import type { EventId } from '../../events';
import { createSimService } from '../../service';
import { STACKS } from '../../stacks';
import { ip, labBuilder, staticRoute } from '../../testing';
import { compositeMetric, DEFAULT_K_VALUES } from './metric';

type Router = Extract<Device, { kind: 'router' }>;

/** Every interface. */
const EVERYWHERE = [{ address: ip('0.0.0.0'), wildcard: ip('255.255.255.255') }];

function edit(topology: Topology, id: DeviceId, change: (router: Router) => Router): Topology {
  const device = topology.devices[id]!;
  if (device.kind !== 'router') throw new Error(`${id} is not a router`);
  return { ...topology, devices: { ...topology.devices, [id]: change(device) } };
}

function withEigrp(topology: Topology, id: DeviceId, eigrp: Partial<EigrpConfig>): Topology {
  return edit(topology, id, (router) => ({
    ...router,
    config: {
      ...router.config,
      eigrp: { asn: 1, networks: EVERYWHERE, passiveInterfaces: [], variance: 1, ...eigrp },
    },
  }));
}

/** Sets fields on one of a router's ports. */
function withPort(
  topology: Topology,
  id: DeviceId,
  port: string,
  fields: Partial<RoutedInterface>,
): Topology {
  return edit(topology, id, (router) => {
    const interfaces = router.config.interfaces as Record<string, RoutedInterface>;
    return {
      ...router,
      config: {
        ...router.config,
        interfaces: { ...interfaces, [port]: { ...interfaces[port]!, ...fields } },
      },
    };
  });
}

/**
 * R1, R2 and R3 in a triangle: R1-R2 and R2-R3 on Gigabit Ethernet, R1-R3 on a T1 serial link.
 * Each has a LAN 192.168.n.0/24 with PCn. All run EIGRP AS 1 on every interface.
 */
function triangle() {
  const lab = labBuilder();
  const r1 = lab.router('R1', {
    'GigabitEthernet0/0': '192.168.1.1/24',
    'GigabitEthernet0/1': '10.0.12.1/30',
    'Serial0/0/0': '10.0.13.1/30',
  });
  const r2 = lab.router('R2', {
    'GigabitEthernet0/0': '192.168.2.1/24',
    'GigabitEthernet0/1': '10.0.12.2/30',
    'GigabitEthernet0/2': '10.0.23.2/30',
  });
  const r3 = lab.router('R3', {
    'GigabitEthernet0/0': '192.168.3.1/24',
    'GigabitEthernet0/2': '10.0.23.1/30',
    'Serial0/0/0': '10.0.13.2/30',
  });
  const pcs = [1, 2, 3].map((n) =>
    lab.host('pc', `PC${n}`, `192.168.${n}.10/24`, `192.168.${n}.1`),
  );
  lab.connect(r1, 'GigabitEthernet0/1', r2, 'GigabitEthernet0/1');
  lab.connect(r2, 'GigabitEthernet0/2', r3, 'GigabitEthernet0/2');
  lab.connect(r1, 'Serial0/0/0', r3, 'Serial0/0/0');
  [r1, r2, r3].forEach((router, n) =>
    lab.connect(pcs[n]!, 'FastEthernet0', router, 'GigabitEthernet0/0'),
  );
  let topology = lab.topology;
  for (const router of [r1, r2, r3]) topology = withEigrp(topology, router, {});
  return { topology, r1, r2, r3, pc1: pcs[0]!, pc3: pcs[2]! };
}

function simulate(topology: Topology) {
  const engine = createEngine({ seed: 1, stacks: STACKS, linkDelay: ms(1) });
  const sim = createSimService({ engine, frames: { now: () => 0, request: () => {} } });
  sim.load(topology);
  const value = <T>(result: { ok: true; value: T } | { ok: false; error: string }): T => {
    if (!result.ok) throw new Error(result.error);
    return result.value;
  };
  const routes = (device: DeviceId): Route[] => value(sim.routes(device));
  /** The EIGRP routes a router installed, as `network [AD/metric] via next hop`. */
  const learned = (device: DeviceId) =>
    routes(device).flatMap((route) =>
      route.source === 'eigrp'
        ? [
            `${route.prefix.address}/${route.prefix.prefixLength} [${route.distance}/${route.metric}] via ${route.via}${route.external ? ' EX' : ''}`,
          ]
        : [],
    );
  const eigrp = (device: DeviceId): EigrpStatus => value(sim.routingProtocols(device)).eigrp!;
  const neighbors = (device: DeviceId) =>
    eigrp(device).neighbors.map((n) => `${n.address} ${n.interface}`);
  /** One destination's topology entry, its paths as `via (distance/reported)` with a role. */
  const topologyOf = (device: DeviceId, prefix: string) => {
    const entry = eigrp(device).topology.find(
      (e) => `${e.prefix.address}/${e.prefix.prefixLength}` === prefix,
    );
    return (
      entry && {
        state: entry.state,
        fd: entry.feasibleDistance,
        paths: entry.paths.map((path) =>
          path.kind === 'neighbor'
            ? `${path.via} (${path.distance}/${path.reported})${path.successor ? ' successor' : path.feasible ? ' feasible' : ''}`
            : path.kind,
        ),
      }
    );
  };
  const notes = (device: DeviceId) =>
    engine.log
      .since(0 as EventId)
      .flatMap((event) => (event.kind === 'note' && event.device === device ? [event.text] : []));
  const at = (seconds: number) => engine.runUntil(simTime(seconds * 1000));
  const ping = (from: DeviceId, target: string) => {
    const events: PingEvent[] = [];
    sim.ping(from, ip(target), { count: 2, timeoutMs: 1000 }, (event) => events.push(event));
    while (!events.some((event) => event.kind === 'summary') && engine.nextTime() !== undefined) {
      engine.step();
    }
    return events.at(-1);
  };
  const patch = (next: Topology, id: DeviceId) =>
    sim.applyPatch({ devices: { [id]: next.devices[id]! }, links: {} });
  return { engine, sim, learned, eigrp, neighbors, topologyOf, notes, at, ping, patch };
}

describe('the EIGRP composite metric', () => {
  const metric = (bandwidth: number, delay: number) =>
    compositeMetric(
      { bandwidth, delay, hops: 1, reliability: 255, load: 1, mtu: 1500 },
      DEFAULT_K_VALUES,
    );

  it('matches the worked examples in Cisco’s EIGRP white paper and the CCNA course', () => {
    // Slowest link 56 kbit/s, total delay 2200 tens of µs: (178571 + 2200) × 256.
    expect(metric(56, 2200)).toBe(46277376);
    expect(metric(128, 1200)).toBe(20307200);
    // A 1024 kbit/s serial link and a Gigabit LAN: (9765 + 2000 + 1) × 256.
    expect(metric(1024, 2001)).toBe(3012096);
  });

  it('gives the distances IOS shows for its default interfaces', () => {
    expect(metric(1_000_000, 1)).toBe(2816); // GigabitEthernet
    expect(metric(100_000, 10)).toBe(28160); // FastEthernet
    expect(metric(8_000_000, 500)).toBe(128256); // Loopback
    expect(metric(1544, 2000)).toBe(2169856); // Serial, T1
    expect(metric(1544, 2001)).toBe(2170112); // T1, then a Gigabit LAN
  });

  it('weighs load and reliability only when their K-values ask', () => {
    const loaded = {
      bandwidth: 1_000_000,
      delay: 1,
      hops: 1,
      reliability: 255,
      load: 128,
      mtu: 1500,
    };
    // K2 = 1: BW / (256 - load) adds 10 / 128, nothing in whole numbers; K5 scales by K5 / (rel + K4).
    expect(compositeMetric(loaded, [1, 1, 1, 0, 0])).toBe(2816);
    expect(compositeMetric(loaded, [1, 0, 1, 0, 255])).toBe(2816);
    expect(compositeMetric({ ...loaded, reliability: 127 }, [1, 0, 1, 0, 255])).toBe(5632);
  });
});

describe('EIGRP on a triangle', () => {
  it('brings up every neighbour and learns every network at the composite metric', () => {
    const { topology, r1, r2, r3 } = triangle();
    const { neighbors, learned, notes, at } = simulate(topology);
    at(3);

    expect(neighbors(r1)).toEqual(['10.0.12.2 GigabitEthernet0/1', '10.0.13.2 Serial0/0/0']);
    expect(neighbors(r2)).toHaveLength(2);
    expect(neighbors(r3)).toHaveLength(2);
    expect(notes(r1)).toContain(
      '%DUAL-5-NBRCHANGE: IP-EIGRP 1: Neighbor 10.0.12.2 (GigabitEthernet0/1) is up: new adjacency',
    );
    expect(learned(r1)).toEqual([
      '10.0.23.0/30 [90/3072] via 10.0.12.2',
      '192.168.2.0/24 [90/3072] via 10.0.12.2',
      // Two Gigabit hops and the LAN: (10 + 3) × 256. The T1 alone would cost 2170112.
      '192.168.3.0/24 [90/3328] via 10.0.12.2',
    ]);
  });

  it('keeps a feasible successor: a neighbour whose reported distance is below the FD', () => {
    const { topology, r1 } = triangle();
    const { topologyOf, at } = simulate(topology);
    at(3);

    expect(topologyOf(r1, '192.168.3.0/24')).toEqual({
      state: 'passive',
      fd: 3328,
      paths: ['10.0.12.2 (3328/3072) successor', '10.0.13.2 (2170112/2816) feasible'],
    });
    // R3 reaches R2's LAN through R2 at 3072, no better than R1's own 3072: no feasible successor.
    expect(topologyOf(r1, '192.168.2.0/24')).toEqual({
      state: 'passive',
      fd: 3072,
      paths: ['10.0.12.2 (3072/2816) successor', '10.0.13.2 (2170368/3072)'],
    });
    // R3 reaches R1's LAN through R2 and tells R1 so over the T1: no use to R1, but it is kept.
    expect(topologyOf(r1, '192.168.1.0/24')).toMatchObject({
      fd: 2816,
      paths: ['connected', '10.0.13.2 (2170624/3328)'],
    });
  });

  it('fails over to the feasible successor without going active, and queries for the rest', () => {
    const { topology, r1, r2, pc1 } = triangle();
    const { learned, notes, at, ping, patch } = simulate(topology);
    at(3);

    patch(withPort(topology, r2, 'GigabitEthernet0/1', { shutdown: true }), r2);
    at(3.5);

    expect(notes(r1)).toContain(
      '%DUAL-5-NBRCHANGE: IP-EIGRP 1: Neighbor 10.0.12.2 (GigabitEthernet0/1) is down: interface down',
    );
    const active = notes(r1).filter((note) => note.includes('is active'));
    // R3's LAN had a feasible successor; R2's LAN and the R2-R3 link did not.
    expect(active.some((note) => note.includes('192.168.3.0/24'))).toBe(false);
    expect(active.some((note) => note.includes('192.168.2.0/24'))).toBe(true);
    expect(learned(r1)).toEqual([
      '10.0.23.0/30 [90/2170112] via 10.0.13.2',
      '192.168.2.0/24 [90/2170368] via 10.0.13.2',
      '192.168.3.0/24 [90/2170112] via 10.0.13.2',
    ]);
    expect(ping(pc1, '192.168.3.10')).toMatchObject({ kind: 'summary', received: 2 });
  });

  it('takes the short way back when the link returns', () => {
    const { topology, r1, r2 } = triangle();
    const { learned, at, patch } = simulate(topology);
    at(3);
    patch(withPort(topology, r2, 'GigabitEthernet0/1', { shutdown: true }), r2);
    at(4);
    patch(topology, r2);
    at(8);

    expect(learned(r1)).toContain('192.168.3.0/24 [90/3328] via 10.0.12.2');
    expect(learned(r1)).toContain('192.168.2.0/24 [90/3072] via 10.0.12.2');
  });

  it('pings across the network once it has converged', () => {
    const { topology, pc1 } = triangle();
    const { at, ping } = simulate(topology);
    at(3);
    expect(ping(pc1, '192.168.3.10')).toMatchObject({ kind: 'summary', sent: 2, received: 2 });
  });

  it('drops a silent neighbour once its hold time runs out', () => {
    const { topology, r1, r2 } = triangle();
    const { neighbors, notes, at, patch } = simulate(topology);
    at(3);
    // R2 stops EIGRP but keeps its links up. Its last hello said hold 6 s, in the fast profile.
    patch(
      edit(topology, r2, (router) => ({
        ...router,
        config: { ...router.config, eigrp: undefined },
      })),
      r2,
    );
    at(7.5);
    expect(neighbors(r1)).toContain('10.0.12.2 GigabitEthernet0/1');
    at(9);
    expect(neighbors(r1)).toEqual(['10.0.13.2 Serial0/0/0']);
    expect(notes(r1)).toContain(
      '%DUAL-5-NBRCHANGE: IP-EIGRP 1: Neighbor 10.0.12.2 (GigabitEthernet0/1) is down: holding time expired',
    );
  });

  it('runs IOS’s hello 5 and hold 15 with the ios timer profile', () => {
    const { topology, r1 } = triangle();
    const { eigrp, neighbors, at } = simulate({
      ...topology,
      settings: { stpTimers: 'fast', routingTimers: 'ios' },
    });
    at(1);
    expect(neighbors(r1)).toHaveLength(2);
    expect(eigrp(r1).timers).toEqual({ hello: 5, hold: 15 });
    at(12);
    for (const neighbor of eigrp(r1).neighbors) {
      expect(neighbor.holdMs).toBeGreaterThan(9_000);
      expect(neighbor.holdMs).toBeLessThanOrEqual(15_000);
    }
  });
});

describe('EIGRP neighbours', () => {
  it('form only within one AS', () => {
    const { topology, r1, r2 } = triangle();
    const { neighbors, learned, at } = simulate(withEigrp(topology, r2, { asn: 2 }));
    at(3);
    expect(neighbors(r1)).toEqual(['10.0.13.2 Serial0/0/0']);
    expect(neighbors(r2)).toEqual([]);
    expect(learned(r1)).not.toContain('192.168.2.0/24 [90/3072] via 10.0.12.2');
  });

  it('form only with matching K-values', () => {
    const { topology, r1, r2 } = triangle();
    const { neighbors, notes, at } = simulate(
      withEigrp(topology, r2, { kValues: [1, 0, 1, 0, 1] }),
    );
    at(3);
    expect(neighbors(r1)).toEqual(['10.0.13.2 Serial0/0/0']);
    expect(notes(r1)).toContain(
      'EIGRP: hello from 10.0.12.2 on GigabitEthernet0/1 has other K-values',
    );
  });

  it('never form on a passive interface, whose network is still advertised', () => {
    const { topology, r1, r2, r3 } = triangle();
    const passive = withEigrp(topology, r1, { passiveInterfaces: ['GigabitEthernet0/1' as never] });
    const { neighbors, learned, at } = simulate(passive);
    at(3);
    expect(neighbors(r1)).toEqual(['10.0.13.2 Serial0/0/0']);
    expect(neighbors(r2)).toEqual(['10.0.23.1 GigabitEthernet0/2']);
    // R3 learns R1's side of the R1-R2 link from both R1 and R2.
    expect(learned(r3).filter((route) => route.startsWith('10.0.12.0/30'))).toEqual([
      '10.0.12.0/30 [90/3072] via 10.0.23.2',
    ]);
  });
});

describe('EIGRP metrics and load sharing', () => {
  it('follows bandwidth and delay on an interface, and shares equal paths', () => {
    const { topology, r1 } = triangle();
    // The T1 made as fast as Gigabit: R3's LAN costs 3328 either way.
    const fast = withPort(topology, r1, 'Serial0/0/0', { bandwidth: 1_000_000, delay: 2 });
    const { learned, at } = simulate(fast);
    at(3);
    expect(learned(r1).filter((route) => route.startsWith('192.168.3.0'))).toEqual([
      '192.168.3.0/24 [90/3328] via 10.0.12.2',
      '192.168.3.0/24 [90/3328] via 10.0.13.2',
    ]);
  });

  it('shares unequal paths with variance, through feasible successors only', () => {
    const { topology, r1 } = triangle();
    let lab = withPort(topology, r1, 'Serial0/0/0', { bandwidth: 1_000_000, delay: 3 });
    const { learned, at } = simulate(withEigrp(lab, r1, { variance: 2 }));
    at(3);
    expect(learned(r1).filter((route) => route.startsWith('192.168.3.0'))).toEqual([
      '192.168.3.0/24 [90/3328] via 10.0.12.2',
      '192.168.3.0/24 [90/3584] via 10.0.13.2',
    ]);
    lab = withEigrp(lab, r1, { variance: 1 });
    const one = simulate(lab);
    one.at(3);
    expect(one.learned(r1).filter((route) => route.startsWith('192.168.3.0'))).toEqual([
      '192.168.3.0/24 [90/3328] via 10.0.12.2',
    ]);
  });
});

describe('EIGRP redistribution', () => {
  it('brings static routes in as external routes, at distance 170', () => {
    const { topology, r1, r3 } = triangle();
    let lab = edit(topology, r3, (router) => ({
      ...router,
      config: {
        ...router.config,
        staticRoutes: [staticRoute('172.16.0.0/16', '192.168.3.10')],
      },
    }));
    lab = withEigrp(lab, r3, {
      redistributeStatic: {
        metric: { bandwidth: 1544, delay: 2000, reliability: 255, load: 1, mtu: 1500 },
      },
    });
    const { learned, topologyOf, at } = simulate(lab);
    at(3);
    // R3's seed metric, then R2's and R1's Gigabit links: (6476 + 2002) × 256.
    expect(learned(r1)).toContain('172.16.0.0/16 [170/2170368] via 10.0.12.2 EX');
    expect(topologyOf(r3, '172.16.0.0/16')).toMatchObject({
      fd: 2169856,
      paths: ['redistributed', '10.0.13.1 (2682368/2170368)'],
    });
  });

  it('takes the metric of the exit interface without one', () => {
    const { topology, r1, r3 } = triangle();
    let lab = edit(topology, r3, (router) => ({
      ...router,
      config: { ...router.config, staticRoutes: [staticRoute('0.0.0.0/0', '192.168.3.10')] },
    }));
    lab = withEigrp(lab, r3, { redistributeStatic: {} });
    const { learned, at } = simulate(lab);
    at(3);
    expect(learned(r1)).toContain('0.0.0.0/0 [170/3328] via 10.0.12.2 EX');
  });
});
