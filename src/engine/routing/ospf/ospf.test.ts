import { describe, expect, it } from 'vitest';
import type { Device, DeviceId, OspfConfig, RipConfig, Topology } from '@/model';
import type { OspfStatus, PingEvent, Route } from '../../api';
import { ms, simTime } from '../../core/time';
import { createEngine } from '../../engine';
import type { EventId } from '../../events';
import { createSimService } from '../../service';
import { STACKS } from '../../stacks';
import { cidr, ip, labBuilder, staticRoute } from '../../testing';

type Router = Extract<Device, { kind: 'router' }>;

const area0 = (address: string, wildcard: string) => ({
  address: ip(address),
  wildcard: ip(wildcard),
  area: 0,
});

/** Every interface in area 0. */
const EVERYWHERE = [area0('0.0.0.0', '255.255.255.255')];

function edit(topology: Topology, id: DeviceId, change: (router: Router) => Router): Topology {
  const device = topology.devices[id]!;
  if (device.kind !== 'router') throw new Error(`${id} is not a router`);
  return { ...topology, devices: { ...topology.devices, [id]: change(device) } };
}

function withOspf(topology: Topology, id: DeviceId, ospf: Partial<OspfConfig>): Topology {
  return edit(topology, id, (router) => ({
    ...router,
    config: {
      ...router.config,
      ospf: { processId: 1, networks: EVERYWHERE, passiveInterfaces: [], ...ospf },
    },
  }));
}

/** Sets OSPF fields on one of a router's ports. */
function withPort(
  topology: Topology,
  id: DeviceId,
  port: string,
  fields: { ospfCost?: number; ospfPriority?: number; shutdown?: boolean },
): Topology {
  return edit(topology, id, (router) => {
    const interfaces = router.config.interfaces as Record<
      string,
      (typeof router.config.interfaces)[keyof typeof router.config.interfaces]
    >;
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
 * R1, R2 and R3 in a triangle: R1-R2 and R2-R3 on Gigabit Ethernet (cost 1), R1-R3 on serial
 * (cost 64). Each has a LAN 192.168.n.0/24 with PCn, and router ID n.n.n.n.
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
  [r1, r2, r3].forEach((router, n) => {
    topology = withOspf(topology, router, { routerId: ip(`${n + 1}.${n + 1}.${n + 1}.${n + 1}`) });
  });
  return { topology, r1, r2, r3, pc1: pcs[0]!, pc3: pcs[2]! };
}

function simulate(topology: Topology, seed = 1) {
  const engine = createEngine({ seed, stacks: STACKS, linkDelay: ms(1) });
  const sim = createSimService({ engine, frames: { now: () => 0, request: () => {} } });
  sim.load(topology);
  const value = <T>(result: { ok: true; value: T } | { ok: false; error: string }): T => {
    if (!result.ok) throw new Error(result.error);
    return result.value;
  };
  const routes = (device: DeviceId): Route[] => value(sim.routes(device));
  /** The routes from `source` a router installed, as `network [AD/metric] via next hop`. */
  const learned = (device: DeviceId, source = 'ospf') =>
    routes(device).flatMap((route) =>
      route.source === source && 'via' in route
        ? [
            `${route.prefix.address}/${route.prefix.prefixLength} [${route.distance}/${route.metric}] via ${route.via}`,
          ]
        : [],
    );
  const ospf = (device: DeviceId): OspfStatus => value(sim.routingProtocols(device)).ospf!;
  /** Each neighbour as `router ID state/role`. */
  const neighbors = (device: DeviceId) =>
    ospf(device).interfaces.flatMap((iface) =>
      iface.neighbors.map((n) => `${n.routerId} ${n.state}${n.role ? `/${n.role}` : ''}`),
    );
  const at = (seconds: number) => engine.runUntil(simTime(seconds * 1000));
  const ping = (from: DeviceId, target: string) => {
    const events: PingEvent[] = [];
    sim.ping(from, ip(target), { count: 2, timeoutMs: 1000 }, (event) => events.push(event));
    while (!events.some((event) => event.kind === 'summary') && engine.nextTime() !== undefined) {
      engine.step();
    }
    return events.at(-1);
  };
  return { engine, sim, routes, learned, ospf, neighbors, at, ping };
}

describe('OSPF on a triangle', () => {
  it('brings every adjacency to FULL: DR and BDR on Ethernet, none on serial', () => {
    const { topology, r1, r2, r3 } = triangle();
    const { neighbors, ospf, at } = simulate(topology);
    at(10);

    // On each Ethernet link the higher router ID is DR, as both wait out the same 4 s.
    expect(neighbors(r1)).toEqual(['2.2.2.2 full/dr', '3.3.3.3 full']);
    expect(neighbors(r2)).toEqual(['1.1.1.1 full/bdr', '3.3.3.3 full/dr']);
    expect(neighbors(r3)).toEqual(['2.2.2.2 full/bdr', '1.1.1.1 full']);
    expect(
      ospf(r1).interfaces.map((iface) => `${iface.name} ${iface.state} ${iface.cost}`),
    ).toEqual([
      'GigabitEthernet0/0 dr 1',
      'GigabitEthernet0/1 backup 1',
      'Serial0/0/0 point-to-point 64',
    ]);
  });

  it('takes the lowest-cost path, and pings across it', () => {
    const { topology, r1, pc1 } = triangle();
    const { learned, at, ping } = simulate(topology);
    at(10);

    expect(learned(r1)).toEqual([
      '10.0.23.0/30 [110/2] via 10.0.12.2',
      '192.168.2.0/24 [110/2] via 10.0.12.2',
      // Two Ethernet hops and the LAN cost 3; the serial link alone costs 64.
      '192.168.3.0/24 [110/3] via 10.0.12.2',
    ]);
    expect(ping(pc1, '192.168.3.10')).toMatchObject({ kind: 'summary', sent: 2, received: 2 });
  });

  it('moves the path when ip ospf cost makes the short way dear', () => {
    const { topology, r1 } = triangle();
    const { sim, learned, at } = simulate(topology);
    at(10);

    const dear = withPort(topology, r1, 'GigabitEthernet0/1', { ospfCost: 100 });
    sim.applyPatch({ devices: { [r1]: dear.devices[r1]! }, links: {} });
    at(11);

    expect(learned(r1)).toContain('192.168.3.0/24 [110/65] via 10.0.13.2');
    expect(learned(r1)).toContain('192.168.2.0/24 [110/66] via 10.0.13.2');
  });

  it('reconverges over the other way when a link goes down, then back when it returns', () => {
    const { topology, r1, r2, pc1 } = triangle();
    const { engine, sim, learned, neighbors, at, ping } = simulate(topology);
    at(10);

    const shut = withPort(topology, r2, 'GigabitEthernet0/1', { shutdown: true });
    sim.applyPatch({ devices: { [r2]: shut.devices[r2]! }, links: {} });
    at(11);
    expect(neighbors(r1)).toEqual(['3.3.3.3 full']);
    expect(learned(r1)).toContain('192.168.3.0/24 [110/65] via 10.0.13.2');
    expect(ping(pc1, '192.168.3.10')).toMatchObject({ received: 2 });
    const down = engine.log
      .since(0 as EventId)
      .filter(
        (event) => event.kind === 'note' && event.device === r1 && event.text.includes('to DOWN'),
      );
    expect(down.map((event) => event.kind === 'note' && event.text)).toEqual([
      '%OSPF-5-ADJCHG: Process 1, Nbr 2.2.2.2 on GigabitEthernet0/1 from FULL to DOWN, Neighbor Down: Interface down or detached',
    ]);

    sim.applyPatch({ devices: { [r2]: topology.devices[r2]! }, links: {} });
    // The link is new to both ends: they wait 8 s, elect, and exchange.
    at(24);
    expect(learned(r1)).toContain('192.168.3.0/24 [110/3] via 10.0.12.2');
  });

  it('declares a silent neighbour dead after the dead interval', () => {
    const { topology, r1, r2 } = triangle();
    const { sim, neighbors, at } = simulate(topology);
    at(10);
    // R2 stops running OSPF but keeps its links up. Its last hello left at 10 s and arrived at
    // 10.001 s, so R1 waits out the 8 s dead interval from then.
    const quiet = edit(topology, r2, (router) => ({
      ...router,
      config: { ...router.config, ospf: undefined },
    }));
    sim.applyPatch({ devices: { [r2]: quiet.devices[r2]! }, links: {} });
    at(17.9);
    expect(neighbors(r1)).toContain('2.2.2.2 full/dr');
    at(18.1);
    expect(neighbors(r1)).toEqual(['3.3.3.3 full']);
  });

  it('comes back from a power cycle, past the LSAs the others kept', () => {
    const { topology, r1, r3 } = triangle();
    const { sim, learned, at } = simulate(topology);
    at(10);
    const off = { ...topology.devices[r3]!, powered: false };
    sim.applyPatch({ devices: { [r3]: off }, links: {} });
    at(14);
    expect(learned(r1).some((route) => route.startsWith('192.168.3.0'))).toBe(false);

    sim.applyPatch({ devices: { [r3]: topology.devices[r3]! }, links: {} });
    at(30);
    expect(learned(r1)).toContain('192.168.3.0/24 [110/3] via 10.0.12.2');
  });
});

describe('OSPF on a multi-access segment', () => {
  /** R1 to R4 on one switch, 10.0.0.n/24, with the given priorities. */
  function segment(priorities: Record<string, number>) {
    const lab = labBuilder();
    const sw = lab.switch('SW1');
    const routers = [1, 2, 3, 4].map((n) => {
      const router = lab.router(`R${n}`, {
        'GigabitEthernet0/0': `10.0.0.${n}/24`,
        Loopback0: `${n}.${n}.${n}.${n}/32`,
      });
      lab.connect(router, 'GigabitEthernet0/0', sw, `FastEthernet0/${n}`);
      return router;
    });
    let topology = lab.topology;
    routers.forEach((router, n) => {
      topology = withOspf(topology, router, {});
      const priority = priorities[`R${n + 1}`];
      if (priority !== undefined)
        topology = withPort(topology, router, 'GigabitEthernet0/0', { ospfPriority: priority });
    });
    return { topology, routers: routers as [DeviceId, DeviceId, DeviceId, DeviceId] };
  }

  it('elects the highest priority DR and the next BDR; DROthers stay 2-Way with each other', () => {
    const { topology, routers } = segment({ R1: 0, R4: 10 });
    const [r1, r2, r3, r4] = routers;
    // Spanning tree holds the switch ports for 4 s, well inside the 8 s wait.
    const { ospf, neighbors, learned, at } = simulate(topology);
    at(16);

    const lan = (router: DeviceId) =>
      ospf(router).interfaces.find((iface) => iface.name === 'GigabitEthernet0/0')!;
    expect(lan(r2)).toMatchObject({
      state: 'drother',
      dr: { routerId: '4.4.4.4', address: '10.0.0.4' },
      bdr: { routerId: '3.3.3.3', address: '10.0.0.3' },
    });
    expect(lan(r4).state).toBe('dr');
    expect(lan(r3).state).toBe('backup');
    // Priority 0 never stands.
    expect(lan(r1).state).toBe('drother');
    expect(neighbors(r1)).toEqual(['2.2.2.2 2way/drother', '3.3.3.3 full/bdr', '4.4.4.4 full/dr']);
    expect(neighbors(r4)).toEqual([
      '1.1.1.1 full/drother',
      '2.2.2.2 full/drother',
      '3.3.3.3 full/bdr',
    ]);
    // The DROthers still route to each other's loopbacks across the DR's network LSA.
    expect(learned(r1)).toContain('2.2.2.2/32 [110/2] via 10.0.0.2');
  });

  it('keeps the sitting DR when a better router joins later', () => {
    const { topology, routers } = segment({});
    const [r1, , , r4] = routers;
    const late = { ...topology.devices[r4]!, powered: false };
    const { sim, ospf, at } = simulate({
      ...topology,
      devices: { ...topology.devices, [r4]: late },
    });
    at(16);
    const drOf = (router: DeviceId) =>
      ospf(router).interfaces.find((iface) => iface.name === 'GigabitEthernet0/0')!.dr?.routerId;
    expect(drOf(r1)).toBe('3.3.3.3');

    sim.applyPatch({ devices: { [r4]: topology.devices[r4]! }, links: {} });
    at(30);
    expect(drOf(r1)).toBe('3.3.3.3');
    expect(drOf(r4)).toBe('3.3.3.3');
  });
});

describe('OSPF options', () => {
  it('sends nothing out of a passive interface, yet advertises its network', () => {
    const base = triangle();
    const topology = withOspf(base.topology, base.r1, {
      routerId: ip('1.1.1.1'),
      passiveInterfaces: ['GigabitEthernet0/0' as never],
    });
    const { engine, learned, ospf, at } = simulate(topology);
    at(10);

    const outLan = engine.log
      .since(0 as EventId)
      .filter(
        (event) =>
          event.kind === 'frame' &&
          event.from.device === base.r1 &&
          event.from.port === 'GigabitEthernet0/0' &&
          event.frame.kind === 'ethernet' &&
          event.frame.payload.kind === 'ipv4' &&
          event.frame.payload.payload.kind === 'ospf',
      );
    expect(outLan).toEqual([]);
    expect(ospf(base.r1).interfaces[0]).toMatchObject({ passive: true, helloDueMs: undefined });
    expect(learned(base.r2)).toContain('192.168.1.0/24 [110/2] via 10.0.12.1');
  });

  it('takes the highest loopback as router ID when none is configured', () => {
    const base = triangle();
    let topology = withOspf(base.topology, base.r1, { routerId: undefined });
    topology = edit(topology, base.r1, (router) => ({
      ...router,
      config: {
        ...router.config,
        virtualInterfaces: {
          ...router.config.virtualInterfaces,
          Loopback0: { shutdown: false, ipv4: cidr('10.9.9.9/32') },
          Loopback1: { shutdown: false, ipv4: cidr('10.1.1.1/32') },
        } as never,
      },
    }));
    const { ospf, learned, at } = simulate(topology);
    at(10);

    expect(ospf(base.r1).routerId).toBe('10.9.9.9');
    expect(learned(base.r2)).toContain('10.9.9.9/32 [110/2] via 10.0.12.1');
  });

  it('prefers static over OSPF over RIP for the same network', () => {
    const base = triangle();
    const rip: RipConfig = {
      version: 2,
      networks: [ip('10.0.0.0'), ip('192.168.1.0'), ip('192.168.2.0'), ip('192.168.3.0')],
      autoSummary: false,
      passiveInterfaces: [],
      defaultOriginate: false,
    };
    let topology = base.topology;
    for (const router of [base.r1, base.r2, base.r3]) {
      topology = edit(topology, router, (device) => ({
        ...device,
        config: { ...device.config, rip },
      }));
    }
    const { sim, routes, at } = simulate(topology);
    at(10);
    const toLan3 = () =>
      routes(base.r1)
        .filter((route) => route.prefix.address === '192.168.3.0')
        .map((route) => route.source);

    expect(toLan3()).toEqual(['ospf']);

    const withoutOspf = edit(topology, base.r1, (device) => ({
      ...device,
      config: { ...device.config, ospf: undefined },
    }));
    sim.applyPatch({ devices: { [base.r1]: withoutOspf.devices[base.r1]! }, links: {} });
    at(9);
    expect(toLan3()).toEqual(['rip']);

    const withStatic = edit(topology, base.r1, (device) => ({
      ...device,
      config: { ...device.config, staticRoutes: [staticRoute('192.168.3.0/24', '10.0.13.2')] },
    }));
    sim.applyPatch({ devices: { [base.r1]: withStatic.devices[base.r1]! }, links: {} });
    at(16);
    expect(toLan3()).toEqual(['static']);
  });

  it('runs the real IOS timers when the lab asks for them: FULL only after the 40 s wait', () => {
    const base = triangle();
    const topology = {
      ...base.topology,
      settings: { stpTimers: 'fast', routingTimers: 'ios' },
    } as Topology;
    const { ospf, neighbors, at } = simulate(topology);
    at(30);
    expect(neighbors(base.r1)).toEqual(['2.2.2.2 2way/drother', '3.3.3.3 full']);

    at(50);
    expect(neighbors(base.r1)).toEqual(['2.2.2.2 full/dr', '3.3.3.3 full']);
    expect(ospf(base.r1).timers).toEqual({
      hello: 10,
      dead: 40,
      wait: 40,
      retransmit: 5,
      spfDelay: 5,
    });
  });
});

describe('OSPF determinism', () => {
  it('runs the same way twice from one seed', () => {
    const { topology } = triangle();
    const first = simulate(topology, 3);
    const second = simulate(topology, 3);
    first.at(30);
    second.at(30);

    expect(second.engine.log.since(0 as EventId)).toEqual(first.engine.log.since(0 as EventId));
  });

  it('replays the same events after a restore to a snapshot taken mid-exchange', () => {
    const { topology, r1 } = triangle();
    const { engine, learned, neighbors, at } = simulate(topology);
    at(10.002);
    const snapshot = engine.snapshot();
    const mark = engine.log.lastId;
    at(20);
    const ahead = engine.log.since(mark);
    const routesAhead = learned(r1);

    engine.restore(snapshot);
    at(20);

    expect(engine.log.since(mark)).toEqual(ahead);
    expect(learned(r1)).toEqual(routesAhead);
    expect(neighbors(r1)).toEqual(['2.2.2.2 full/dr', '3.3.3.3 full']);
  });
});
