import { describe, expect, it } from 'vitest';
import type { DeviceId, RipConfig, Topology } from '@/model';
import type { PingEvent, Route } from '../api';
import { ms, simTime } from '../core/time';
import { createEngine, type Engine } from '../engine';
import type { EventId, SimEvent } from '../events';
import type { RipMessage } from '../pdu';
import { createSimService } from '../service';
import { STACKS } from '../stacks';
import { ip, labBuilder } from '../testing';

const V2: RipConfig = {
  version: 2,
  networks: [],
  autoSummary: false,
  passiveInterfaces: [],
  defaultOriginate: false,
};

/** The topology with `rip` on each named router, over any RIP config it has. */
function withRip(topology: Topology, configs: Record<DeviceId, Partial<RipConfig>>): Topology {
  const devices = { ...topology.devices };
  for (const [id, rip] of Object.entries(configs) as [DeviceId, Partial<RipConfig>][]) {
    const device = devices[id]!;
    if (device.kind !== 'router') throw new Error(`${id} is not a router`);
    const merged = { ...V2, ...device.config.rip, ...rip };
    devices[id] = { ...device, config: { ...device.config, rip: merged } };
  }
  return { ...topology, devices };
}

/**
 * R1 - R2 - R3 on serial links 10.0.12.0/30 and 10.0.23.0/30, each with a LAN 192.168.n.0/24 on
 * Gi0/0 and a PC on it. With `triangle`, R1 and R3 also meet on Ethernet 10.0.13.0/30.
 */
function routers({ triangle = false } = {}) {
  const lab = labBuilder();
  const r1 = lab.router('R1', {
    'GigabitEthernet0/0': '192.168.1.1/24',
    'Serial0/0/0': '10.0.12.1/30',
    ...(triangle && { 'GigabitEthernet0/1': '10.0.13.1/30' }),
  });
  const r2 = lab.router('R2', {
    'GigabitEthernet0/0': '192.168.2.1/24',
    'Serial0/0/0': '10.0.12.2/30',
    'Serial0/0/1': '10.0.23.2/30',
  });
  const r3 = lab.router('R3', {
    'GigabitEthernet0/0': '192.168.3.1/24',
    'Serial0/0/1': '10.0.23.1/30',
    ...(triangle && { 'GigabitEthernet0/1': '10.0.13.2/30' }),
  });
  const pc1 = lab.host('pc', 'PC1', '192.168.1.10/24', '192.168.1.1');
  const pc3 = lab.host('pc', 'PC3', '192.168.3.10/24', '192.168.3.1');
  const pc2 = lab.host('pc', 'PC2', '192.168.2.10/24', '192.168.2.1');
  lab.connect(r1, 'Serial0/0/0', r2, 'Serial0/0/0');
  lab.connect(r2, 'Serial0/0/1', r3, 'Serial0/0/1');
  if (triangle) lab.connect(r1, 'GigabitEthernet0/1', r3, 'GigabitEthernet0/1');
  lab.connect(pc1, 'FastEthernet0', r1, 'GigabitEthernet0/0');
  lab.connect(pc3, 'FastEthernet0', r3, 'GigabitEthernet0/0');
  lab.connect(pc2, 'FastEthernet0', r2, 'GigabitEthernet0/0');
  const networks = {
    networks: [ip('10.0.0.0'), ip('192.168.1.0'), ip('192.168.2.0'), ip('192.168.3.0')],
  };
  const topology = withRip(lab.topology, { [r1]: networks, [r2]: networks, [r3]: networks });
  return { topology, r1, r2, r3, pc1, pc3 };
}

function simulate(topology: Topology, seed = 1) {
  const engine = createEngine({ seed, stacks: STACKS, linkDelay: ms(1) });
  const sim = createSimService({ engine, frames: { now: () => 0, request: () => {} } });
  sim.load(topology);
  const routesOf = (device: DeviceId): Route[] => {
    const result = sim.routes(device);
    if (!result.ok) throw new Error(result.error);
    return result.value;
  };
  /** The RIP routes a router installed, as `network [AD/metric] via next hop`. */
  const rip = (device: DeviceId) =>
    routesOf(device).flatMap((route) =>
      route.source === 'rip'
        ? [
            `${route.prefix.address}/${route.prefix.prefixLength} [${route.distance}/${route.metric}] via ${route.via}`,
          ]
        : [],
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
  return { engine, sim, rip, at, ping, routesOf };
}

type RipFrame = { from: DeviceId; port: string; dst: string; message: RipMessage };

/** The RIP messages devices sent, in order, from the engine's log. */
function ripSent(engine: Engine, since = 0 as EventId): RipFrame[] {
  return engine.log.since(since).flatMap((event: SimEvent) => {
    if (event.kind !== 'frame' || event.outcome !== 'delivered') return [];
    const { frame } = event;
    const packet =
      frame.kind === 'hdlc'
        ? frame.payload
        : frame.kind === 'ethernet' && frame.payload.kind === 'ipv4'
          ? frame.payload
          : undefined;
    const udp = packet?.payload;
    if (udp?.kind !== 'udp' || udp.payload.kind !== 'rip') return [];
    return [
      { from: event.from.device, port: event.from.port, dst: packet!.dst, message: udp.payload },
    ];
  });
}

const routesIn = (message: RipMessage) =>
  message.command === 'response'
    ? message.entries.map(
        (entry) => `${entry.network}/${entry.prefixLength ?? '-'} ${entry.metric}`,
      )
    : [];

describe('RIPv2 on a line of three routers', () => {
  it('learns every remote network with its hop count', () => {
    const { topology, r1, r3 } = routers();
    const { rip, at } = simulate(topology);
    at(1);

    expect(rip(r1)).toEqual([
      '10.0.23.0/30 [120/1] via 10.0.12.2',
      '192.168.2.0/24 [120/1] via 10.0.12.2',
      '192.168.3.0/24 [120/2] via 10.0.12.2',
    ]);
    expect(rip(r3)).toEqual([
      '10.0.12.0/30 [120/1] via 10.0.23.2',
      '192.168.1.0/24 [120/2] via 10.0.23.2',
      '192.168.2.0/24 [120/1] via 10.0.23.2',
    ]);
  });

  it('carries a ping from one end to the other', () => {
    const { topology, pc1 } = routers();
    const { at, ping } = simulate(topology);
    at(1);

    expect(ping(pc1, '192.168.3.10')).toMatchObject({ kind: 'summary', sent: 2, received: 2 });
  });

  it('asks for tables when it starts, then multicasts to 224.0.0.9 every update period', () => {
    const { topology, r1 } = routers();
    const { engine, at } = simulate(topology);
    at(12);

    const fromR1 = ripSent(engine).filter((sent) => sent.from === r1);
    expect(fromR1[0]).toMatchObject({
      dst: '224.0.0.9',
      message: { command: 'request', version: 2 },
    });
    const periodic = engine.log
      .since(0 as EventId)
      .filter(
        (event) =>
          event.kind === 'frame' &&
          event.from.device === r1 &&
          event.from.port === 'Serial0/0/0' &&
          event.time >= 1000,
      )
      .map((event) => event.time);
    // Fast timers: an update every 5 s after RIP started at 0.
    expect(periodic).toEqual([5000, 10000].map((time) => time + 1));
  });

  it('keeps split horizon: no route goes back out of the interface it was learned on', () => {
    const { topology, r2 } = routers();
    const { engine, at } = simulate(topology);
    at(11);

    const towardR1 = ripSent(engine).filter(
      (sent) =>
        sent.from === r2 && sent.port === 'Serial0/0/0' && sent.message.command === 'response',
    );
    expect(towardR1.length).toBeGreaterThan(2);
    for (const { message } of towardR1) {
      // 192.168.1.0 and 10.0.12.0 are R1's side: R2 learned one there and sits on the other.
      expect(routesIn(message).some((text) => /^192\.168\.1\.0|^10\.0\.12\.0/.test(text))).toBe(
        false,
      );
    }
    expect(routesIn(towardR1.at(-1)!.message)).toEqual([
      '10.0.23.0/30 1',
      '192.168.2.0/24 1',
      '192.168.3.0/24 2',
    ]);
  });

  it('poisons a lost network, holds it down, then flushes it', () => {
    const { topology, r1, r2, r3 } = routers();
    const { engine, sim, rip, at } = simulate(topology);
    at(1);
    const mark = engine.log.lastId;

    // R3's LAN goes down: R3 poisons it at once, and R2 passes the poison on.
    const lan = topology.devices[r3]!;
    if (lan.kind !== 'router') throw new Error('not a router');
    const shut = {
      ...lan,
      config: {
        ...lan.config,
        interfaces: {
          ...lan.config.interfaces,
          'GigabitEthernet0/0': {
            ...lan.config.interfaces['GigabitEthernet0/0' as never]!,
            shutdown: true,
          },
        },
      },
    };
    sim.applyPatch({ devices: { [r3]: shut }, links: {} });
    at(1.1);

    const poison = ripSent(engine, mark).filter((sent) =>
      routesIn(sent.message).includes('192.168.3.0/24 16'),
    );
    expect(poison.map((sent) => [sent.from, sent.port])).toEqual([
      [r3, 'Serial0/0/1'],
      [r2, 'GigabitEthernet0/0'],
      [r2, 'Serial0/0/0'],
      [r1, 'GigabitEthernet0/0'],
    ]);
    expect(rip(r1)).not.toContain('192.168.3.0/24 [120/2] via 10.0.12.2');
    // Fast timers: unreachable now, flushed flush - invalid = 5 s later.
    at(5.9);
    expect(
      engine.log
        .since(mark)
        .some((event) => event.kind === 'note' && event.text === 'RIP: 192.168.3.0/24 flushed'),
    ).toBe(false);
    at(6.2);
    expect(
      engine.log
        .since(mark)
        .filter((event) => event.kind === 'note' && event.device === r1)
        .map((event) => event.kind === 'note' && event.text),
    ).toEqual(['RIP: 192.168.3.0/24 is unreachable, held down', 'RIP: 192.168.3.0/24 flushed']);
  });

  it('times a silent neighbour out: invalid after 15 s, flushed at 20 s on the fast timers', () => {
    const { topology, r1, r2 } = routers();
    const { engine, sim, rip, at } = simulate(topology);
    at(1);
    // R2 stops talking RIP. R1's routes through it age out.
    const r2Device = topology.devices[r2]!;
    if (r2Device.kind !== 'router') throw new Error('not a router');
    const quiet = { ...r2Device, config: { ...r2Device.config, rip: undefined } };
    sim.applyPatch({ devices: { [r2]: quiet }, links: {} });
    const lastHeard = 0;

    at(lastHeard + 14.9);
    expect(rip(r1)).toHaveLength(3);
    at(lastHeard + 15.1);
    expect(rip(r1)).toEqual([]);
    const notes = engine.log
      .since(0 as EventId)
      .flatMap((event) => (event.kind === 'note' && event.device === r1 ? [event] : []));
    expect(notes.find((note) => note.text === 'RIP: 192.168.3.0/24 flushed')?.time).toBeUndefined();
    at(lastHeard + 20.1);
    expect(
      engine.log
        .since(0 as EventId)
        .some(
          (event) =>
            event.kind === 'note' &&
            event.device === r1 &&
            event.text === 'RIP: 192.168.3.0/24 flushed',
        ),
    ).toBe(true);
  });
});

describe('RIP around a triangle', () => {
  it('reroutes through the other neighbour when a link dies, poisoning the lost path', () => {
    const { topology, r1, r3 } = routers({ triangle: true });
    const { engine, sim, rip, at, ping } = simulate(topology);
    at(1);
    expect(rip(r1)).toContain('192.168.3.0/24 [120/1] via 10.0.13.2');

    const link = Object.values(topology.links).find(
      (candidate) => candidate.a.device === r1 && candidate.a.port === 'GigabitEthernet0/1',
    )!;
    const mark = engine.log.lastId;
    sim.applyPatch({ devices: {}, links: { [link.id]: null } });
    at(1.01);

    // R1 lost its interface toward R3: it poisons what it reached that way, and is not held
    // down, so R2's next periodic update brings the long way round.
    const poisoned = ripSent(engine, mark).filter(
      (sent) => sent.from === r1 && routesIn(sent.message).includes('192.168.3.0/24 16'),
    );
    expect(poisoned.map((sent) => sent.port)).toEqual(['GigabitEthernet0/0', 'Serial0/0/0']);
    expect(rip(r1)).not.toContain('192.168.3.0/24 [120/1] via 10.0.13.2');
    at(6);
    expect(rip(r1)).toContain('192.168.3.0/24 [120/2] via 10.0.12.2');
    expect(ping(r1, '192.168.3.10')).toMatchObject({ received: 2 });
    void r3;
  });
});

describe('RIP options', () => {
  it('sends nothing out of a passive interface, yet still advertises its network', () => {
    const base = routers();
    const topology = withRip(base.topology, {
      [base.r1]: {
        networks: [ip('10.0.0.0'), ip('192.168.1.0')],
        passiveInterfaces: ['GigabitEthernet0/0' as never],
      },
    });
    const { engine, rip, at } = simulate(topology);
    at(11);

    const outLan = ripSent(engine).filter(
      (sent) => sent.from === base.r1 && sent.port === 'GigabitEthernet0/0',
    );
    expect(outLan).toEqual([]);
    expect(rip(base.r2)).toContain('192.168.1.0/24 [120/1] via 10.0.12.1');
  });

  it('runs RIPv1 by default: broadcasts, no masks, summarised at the classful boundary', () => {
    const base = routers();
    const v1 = { version: undefined, autoSummary: true };
    const topology = withRip(base.topology, { [base.r1]: v1, [base.r2]: v1, [base.r3]: v1 });
    const { engine, rip, at } = simulate(topology);
    at(6);

    const update = ripSent(engine).find(
      (sent) =>
        sent.from === base.r2 && sent.port === 'Serial0/0/0' && sent.message.command === 'response',
    )!;
    expect(update).toMatchObject({ dst: '255.255.255.255', message: { version: 1 } });
    expect(routesIn(update.message).every((text) => text.includes('/- '))).toBe(true);
    // 10.0.23.0/30 shares R1's classful network and mask, so R1 infers /30 for it.
    expect(rip(base.r1)).toEqual([
      '10.0.23.0/30 [120/1] via 10.0.12.2',
      '192.168.2.0/24 [120/1] via 10.0.12.2',
      '192.168.3.0/24 [120/2] via 10.0.12.2',
    ]);
  });

  it('summarises another classful network with auto-summary on RIPv2', () => {
    const base = routers();
    const summary = { autoSummary: true };
    const topology = withRip(base.topology, { [base.r3]: summary });
    // R3's LAN becomes 172.16.3.0/24, a subnet of class B 172.16.0.0.
    const r3 = topology.devices[base.r3]!;
    if (r3.kind !== 'router') throw new Error('not a router');
    const lan = { shutdown: false, ipv4: { address: ip('172.16.3.1'), prefixLength: 24 as never } };
    const moved = {
      ...r3,
      config: {
        ...r3.config,
        interfaces: { ...r3.config.interfaces, 'GigabitEthernet0/0': lan },
        rip: { ...r3.config.rip!, networks: [ip('10.0.0.0'), ip('172.16.0.0')] },
      },
    };
    const { rip, at } = simulate({
      ...topology,
      devices: { ...topology.devices, [base.r3]: moved },
    });
    at(1);

    expect(rip(base.r2)).toContain('172.16.0.0/16 [120/1] via 10.0.23.1');
  });

  it('originates a default route with default-information originate', () => {
    const base = routers();
    const topology = withRip(base.topology, { [base.r3]: { defaultOriginate: true } });
    const { routesOf, rip, at } = simulate(topology);
    at(1);

    expect(rip(base.r1)).toContain('0.0.0.0/0 [120/2] via 10.0.12.2');
    expect(routesOf(base.r3).some((route) => route.prefix.prefixLength === 0)).toBe(false);
  });

  it('runs the real IOS timers when the lab asks for them', () => {
    const base = routers();
    const topology = {
      ...base.topology,
      settings: { stpTimers: 'fast', routingTimers: 'ios' },
    } as Topology;
    const { engine, sim, at } = simulate(topology);
    at(31);

    const periodic = ripSent(engine).filter(
      (sent) => sent.from === base.r1 && sent.port === 'Serial0/0/0',
    );
    expect(periodic.length).toBeGreaterThan(0);
    const status = sim.routingProtocols(base.r1);
    expect(status.ok && status.value.rip).toMatchObject({
      timers: { update: 30, invalid: 180, holddown: 180, flush: 240 },
      interfaces: ['GigabitEthernet0/0', 'Serial0/0/0'],
      sources: [{ gateway: '10.0.12.2' }],
    });
    expect(status.ok && status.value.rip!.nextUpdateMs).toBe(29_000);
  });
});

describe('RIP determinism', () => {
  it('runs the same way twice from one seed', () => {
    const { topology } = routers({ triangle: true });
    const first = simulate(topology, 7);
    const second = simulate(topology, 7);
    first.at(30);
    second.at(30);

    expect(second.engine.log.since(0 as EventId)).toEqual(first.engine.log.since(0 as EventId));
  });

  it('replays the same events after a restore to a snapshot', () => {
    const { topology, r1 } = routers({ triangle: true });
    const { engine, rip, at } = simulate(topology);
    at(3);
    const snapshot = engine.snapshot();
    const mark = engine.log.lastId;
    at(14);
    const ahead = engine.log.since(mark);
    const routesAhead = rip(r1);

    engine.restore(snapshot);
    at(14);

    expect(engine.log.since(mark)).toEqual(ahead);
    expect(rip(r1)).toEqual(routesAhead);
  });
});
