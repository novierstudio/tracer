import { describe, expect, it } from 'vitest';
import {
  BridgePriority,
  PathCost,
  PortId,
  VlanId,
  type DeviceId,
  type Link,
  type StpTimers,
} from '@/model';
import type { PingEvent, SpanningTreeVlan } from '../api';
import { after, ms, simTime } from '../core/time';
import { createEngine } from '../engine';
import type { EventId, SimEvent } from '../events';
import { createSimService } from '../service';
import { STACKS } from '../stacks';
import { ip, labBuilder, STP_CONVERGED, STP_CONVERGED_IOS } from '../testing';

const VLAN1 = VlanId.parse(1);
/** Listening then learning on the default fast timers: a new port forwards 4 s after it comes up. */
const CONVERGED = STP_CONVERGED;

const FAST = { hello: 2, maxAge: 8, forwardDelay: 2 };
const IOS = { hello: 2, maxAge: 20, forwardDelay: 15 };

const timersPatch = (stpTimers: StpTimers) => ({
  devices: {},
  links: {},
  settings: { stpTimers, routingTimers: 'fast' as const },
});

/**
 * Three switches cabled in a triangle on their gigabit ports, PC1 on SW2 Fa0/1 and PC2 on SW3
 * Fa0/1, every switch at factory defaults, on the lab's spanning tree timers.
 */
function triangle({ portfast = false, timers }: { portfast?: boolean; timers?: StpTimers } = {}) {
  const lab = labBuilder();
  const sw1 = lab.switch('SW1');
  const sw2 = lab.switch('SW2');
  const sw3 = lab.switch('SW3');
  const pc1 = lab.host('pc', 'PC1', '10.0.0.1/24');
  const pc2 = lab.host('pc', 'PC2', '10.0.0.2/24');
  lab.connect(sw1, 'GigabitEthernet0/1', sw2, 'GigabitEthernet0/1');
  lab.connect(sw1, 'GigabitEthernet0/2', sw3, 'GigabitEthernet0/1');
  lab.connect(sw2, 'GigabitEthernet0/2', sw3, 'GigabitEthernet0/2');
  lab.connect(pc1, 'FastEthernet0', sw2, 'FastEthernet0/1');
  lab.connect(pc2, 'FastEthernet0', sw3, 'FastEthernet0/1');
  let topology = lab.topology;
  if (portfast) {
    const device = topology.devices[sw2]!;
    if (device.kind !== 'switch') throw new Error('SW2 is not a switch');
    const fa01 = PortId.parse('FastEthernet0/1');
    const interfaces = {
      ...device.config.interfaces,
      [fa01]: { ...device.config.interfaces[fa01]!, portfast: true as const },
    };
    topology = {
      ...topology,
      devices: {
        ...topology.devices,
        [sw2]: { ...device, config: { ...device.config, interfaces } },
      },
    };
  }

  if (timers) topology = { ...topology, settings: { stpTimers: timers, routingTimers: 'fast' } };

  const engine = createEngine({ seed: 1, stacks: STACKS, linkDelay: ms(1) });
  const sim = createSimService({ engine, frames: { now: () => 0, request: () => {} } });
  sim.load(topology);

  const switches = { [sw1]: 'SW1', [sw2]: 'SW2', [sw3]: 'SW3' } as Record<DeviceId, string>;
  const bridgeMac = (id: DeviceId) => {
    const port = topology.devices[id]!.ports[0]!;
    if (port.kind === 'serial') throw new Error('no MAC on a serial port');
    return port.mac;
  };
  /** With every priority at its default, the lowest MAC wins: root first, then the runner-up. */
  const [root, middle, last] = [sw1, sw2, sw3].sort((a, b) =>
    bridgeMac(a).localeCompare(bridgeMac(b)),
  ) as [DeviceId, DeviceId, DeviceId];

  const tree = (id: DeviceId): SpanningTreeVlan => {
    const result = sim.spanningTree(id);
    if (!result.ok) throw new Error(result.error);
    const vlan = result.value.find((instance) => instance.vlan === VLAN1);
    if (!vlan) throw new Error(`${switches[id]} runs no tree for VLAN 1`);
    return vlan;
  };
  /** Each switch port in VLAN 1 as `Gi0/1 root forwarding`. */
  const ports = (id: DeviceId) =>
    tree(id).ports.map(({ port, role, state }) => `${port} ${role} ${state}`);
  /** Every switch port that blocks, as `SW3 GigabitEthernet0/2`. */
  const blocked = () =>
    [sw1, sw2, sw3].flatMap((id) =>
      tree(id)
        .ports.filter((port) => port.state === 'blocking')
        .map((port) => `${switches[id]} ${port.port}`),
    );
  const runFor = (millis: number) => engine.runUntil(after(engine.now, ms(millis)));
  /** The link between two switches. */
  const linkBetween = (a: DeviceId, b: DeviceId): Link =>
    Object.values(topology.links).find(
      (link) =>
        (link.a.device === a && link.b.device === b) ||
        (link.a.device === b && link.b.device === a),
    )!;
  const unplug = (link: Link) => engine.applyPatch({ devices: {}, links: { [link.id]: null } });
  const portToward = (from: DeviceId, to: DeviceId) => {
    const link = linkBetween(from, to);
    return link.a.device === from ? link.a.port : link.b.port;
  };
  const ping = (count = 4) => {
    const events: PingEvent[] = [];
    const started = sim.ping(pc1, ip('10.0.0.2'), { count, timeoutMs: 1000 }, (event) =>
      events.push(event),
    );
    if (!started.ok) throw new Error(started.error);
    while (!events.some((event) => event.kind === 'summary')) engine.step();
    return events;
  };
  return {
    engine,
    sim,
    topology,
    switches,
    sw1,
    sw2,
    sw3,
    pc1,
    pc2,
    root,
    middle,
    last,
    bridgeMac,
    tree,
    ports,
    blocked,
    runFor,
    linkBetween,
    unplug,
    portToward,
    ping,
  };
}

const isBpdu = (event: SimEvent) =>
  event.kind === 'frame' && event.frame.kind === 'ethernet' && event.frame.payload.kind === 'bpdu';

/** Spanning tree's and CDP's own frames, which each switch sends its neighbours unasked. */
const isControl = (event: SimEvent) =>
  event.kind === 'frame' &&
  event.frame.kind === 'ethernet' &&
  (event.frame.payload.kind === 'bpdu' || event.frame.payload.kind === 'cdp');

const delivered = (events: SimEvent[]) =>
  events.filter((event) => event.kind === 'frame' && event.outcome === 'delivered');

describe('spanning tree in a triangle of switches', () => {
  it('elects the bridge with the lowest MAC as root and blocks exactly one port', () => {
    const { root, middle, last, tree, ports, blocked, runFor, portToward, bridgeMac, switches } =
      triangle();
    runFor(CONVERGED);

    for (const id of [root, middle, last]) {
      expect(tree(id).root).toEqual({ priority: 32769, mac: bridgeMac(root) });
    }
    expect(tree(root).rootPort).toBeUndefined();
    expect(tree(middle).rootPort?.port).toBe(portToward(middle, root));
    expect(tree(last).rootPort?.port).toBe(portToward(last, root));
    // Both non-root bridges are 4 from the root; the lower bridge ID is designated between them.
    expect(blocked()).toEqual([`${switches[last]} ${portToward(last, middle)}`]);
    expect(ports(last)).toContain(`${portToward(last, middle)} alternate blocking`);
    expect(ports(middle)).toContain(`${portToward(middle, last)} designated forwarding`);
    expect(tree(last).rootCost).toBe(4);
  });

  it.each([
    { timers: 'fast', forwardDelay: 2_000 },
    { timers: 'ios', forwardDelay: 15_000 },
  ] as const)(
    'on $timers timers, listens for one forward delay, then learns for another, then forwards',
    ({ timers, forwardDelay }) => {
      const { root, ports, runFor, portToward, middle } = triangle({ timers });
      const toMiddle = portToward(root, middle);

      runFor(forwardDelay - 1);
      expect(ports(root)).toContain(`${toMiddle} designated listening`);
      runFor(1);
      expect(ports(root)).toContain(`${toMiddle} designated learning`);
      runFor(forwardDelay - 1);
      expect(ports(root)).toContain(`${toMiddle} designated learning`);
      runFor(1);
      expect(ports(root)).toContain(`${toMiddle} designated forwarding`);
    },
  );

  it('converges with one blocked port by 4 s on the default timers, and by 30 s on IOS timers', () => {
    const fast = triangle();
    fast.runFor(CONVERGED);
    expect(fast.blocked()).toHaveLength(1);
    expect(fast.ports(fast.root).filter((port) => !port.endsWith('forwarding'))).toEqual([]);

    const ios = triangle({ timers: 'ios' });
    ios.runFor(CONVERGED);
    expect(ios.ports(ios.root)).toContain('GigabitEthernet0/1 designated listening');
    ios.runFor(STP_CONVERGED_IOS - CONVERGED);
    expect(ios.blocked()).toEqual(fast.blocked());
    expect(ios.ports(ios.root)).toEqual(fast.ports(fast.root));
  });

  it('passes a ping between hosts on different switches, with no broadcast storm', () => {
    const { engine, ping, runFor } = triangle();
    runFor(CONVERGED);
    const mark = engine.log.lastId;

    const events = ping();

    expect(events.at(-1)).toMatchObject({ kind: 'summary', sent: 4, received: 4 });
    const traffic = delivered(engine.log.since(mark)).filter((event) => !isControl(event));
    // One ARP request crossing each of the 5 links once (one copy dies on the blocked port),
    // one reply across the 3 links of the path, then 4 echoes and 4 replies of 3 hops each.
    expect(traffic).toHaveLength(5 + 3 + 4 * 3 * 2);

    const quiet = engine.log.lastId;
    runFor(60_000);
    expect(delivered(engine.log.since(quiet)).filter((event) => !isControl(event))).toEqual([]);
  });

  it('moves the root to a bridge given a better priority, and moves the blocked port with it', () => {
    const lab = triangle();
    const { engine, topology, root, middle, last, tree, blocked, runFor, portToward } = lab;
    runFor(CONVERGED);

    const device = topology.devices[last]!;
    if (device.kind !== 'switch') throw new Error('not a switch');
    const stpPriorities = { [VLAN1]: BridgePriority.parse(4096) };
    engine.applyPatch({
      devices: { [last]: { ...device, config: { ...device.config, stpPriorities } } },
      links: {},
    });
    runFor(CONVERGED + 5_000);

    for (const id of [root, middle, last]) {
      expect(tree(id).root).toEqual({ priority: 4097, mac: lab.bridgeMac(last) });
    }
    expect(tree(last).bridge.priority).toBe(4097);
    // The old root and the runner-up now tie on cost to the new root; the old root's lower MAC wins.
    expect(blocked()).toEqual([`${lab.switches[middle]} ${portToward(middle, root)}`]);
  });

  it('brings the blocked port to forwarding when the root port beside it fails', () => {
    const { root, last, middle, ports, blocked, runFor, linkBetween, unplug, portToward } =
      triangle();
    runFor(CONVERGED);
    const standby = portToward(last, middle);

    unplug(linkBetween(last, root));
    expect(ports(last)).toEqual([
      'FastEthernet0/1 designated forwarding',
      `${standby} root listening`,
    ]);
    runFor(CONVERGED);

    expect(ports(last)).toContain(`${standby} root forwarding`);
    expect(blocked()).toEqual([]);
  });

  it.each([
    // The last BPDU before the failure came with the root's previous hello, with message age 1.
    { timers: 'fast', agesOut: 9_002, nextHello: 10_000, forwardDelay: 2 },
    { timers: 'ios', agesOut: 47_002, nextHello: 48_000, forwardDelay: 15 },
  ] as const)(
    'on $timers timers, reconverges after max age when a link it does not touch fails',
    ({ timers, agesOut, nextHello, forwardDelay }) => {
      const lab = triangle({ timers });
      const { engine, root, last, middle, tree, ports, blocked, linkBetween, unplug } = lab;
      const runUntil = (millis: number) => engine.runUntil(simTime(millis));
      runUntil(2 * forwardDelay * 1000);
      const standby = lab.portToward(last, middle);

      unplug(linkBetween(middle, root));
      // The middle bridge thinks itself root, but the last bridge ignores its worse BPDUs until
      // the root's information on its blocked port ages out: max age less the message age of 1
      // it arrived with, counted from the last BPDU before the failure.
      runUntil(agesOut - 1);
      expect(ports(last)).toContain(`${standby} alternate blocking`);
      runUntil(agesOut);
      expect(ports(last)).toContain(`${standby} designated listening`);
      // Its relay of the root's next hello tells the middle bridge the way back to the root.
      runUntil(nextHello + 2);
      expect(tree(middle).rootPort?.port).toBe(lab.portToward(middle, last));

      runUntil(agesOut + 2 * forwardDelay * 1000 - 1);
      expect(ports(last)).toContain(`${standby} designated learning`);
      runUntil(agesOut + 2 * forwardDelay * 1000);
      expect(ports(last)).toContain(`${standby} designated forwarding`);
      expect(blocked()).toEqual([]);
      // The root heard of the change and tells every bridge to age addresses after forward delay.
      runUntil(engine.now + 100);
      expect(tree(middle).agingTime).toBe(forwardDelay);
    },
  );

  it('pings across the backup path once the tree reconverges around a failed link', () => {
    const { ping, runFor, linkBetween, unplug, root, last } = triangle();
    runFor(CONVERGED);
    ping(1);

    unplug(linkBetween(last, root));
    runFor(CONVERGED);

    expect(ping().at(-1)).toMatchObject({ kind: 'summary', sent: 4, received: 4 });
  });
});

describe('PortFast', () => {
  it('sends an access port straight to forwarding while others listen', () => {
    const { sw2, sw3, ports } = triangle({ portfast: true });

    expect(ports(sw2)).toContain('FastEthernet0/1 designated forwarding');
    expect(ports(sw3)).toContain('FastEthernet0/1 designated listening');
  });

  it('reports PortFast as an edge port and a configured cost in place of the speed cost', () => {
    const { engine, topology, sw2, tree } = triangle({ portfast: true });
    const device = topology.devices[sw2]!;
    if (device.kind !== 'switch') throw new Error('not a switch');
    const gi01 = PortId.parse('GigabitEthernet0/1');
    const interfaces = {
      ...device.config.interfaces,
      [gi01]: { ...device.config.interfaces[gi01]!, stpCost: PathCost.parse(100) },
    };
    engine.applyPatch({
      devices: { [sw2]: { ...device, config: { ...device.config, interfaces } } },
      links: {},
    });

    expect(tree(sw2).ports.map(({ port, cost, edge }) => [port, cost, edge])).toEqual([
      ['FastEthernet0/1', 19, true],
      ['GigabitEthernet0/1', 100, false],
      ['GigabitEthernet0/2', 4, false],
    ]);
  });
});

describe('link lights', () => {
  it('holds every switch end until it forwards, then only the blocked one', () => {
    const { engine, topology, last, middle, linkBetween, runFor, portToward } = triangle();
    const ends = () =>
      Object.values(topology.links).flatMap((link) => {
        const state = engine.linkStates()[link.id]!;
        return [
          [link.a.device, link.a.port, state.a],
          [link.b.device, link.b.port, state.b],
        ];
      });
    const held = () => ends().filter(([, , state]) => state === 'held');

    expect(held()).toHaveLength(8);
    runFor(CONVERGED);

    expect(held()).toEqual([[last, portToward(last, middle), 'held']]);
    expect(engine.linkStates()[linkBetween(last, middle).id]).toMatchObject(
      linkBetween(last, middle).a.device === last ? { a: 'held', b: 'up' } : { a: 'up', b: 'held' },
    );
  });
});

describe('BPDUs', () => {
  it('go out every designated port each hello time, and none out a blocked port', () => {
    const { engine, last, middle, runFor, portToward } = triangle();
    // Past the topology change that ports going forwarding raise, which adds TCNs and acks.
    runFor(100_000);
    const mark = engine.log.lastId as EventId;

    runFor(10_000);
    const bpdus = engine.log.since(mark).filter(isBpdu);
    const fromBlocked = bpdus.filter(
      (event) =>
        event.kind === 'frame' &&
        event.from.device === last &&
        event.from.port === portToward(last, middle),
    );
    expect(fromBlocked).toEqual([]);
    // 5 hellos, each out of 5 designated ports: the root's 2, and one toward each other bridge
    // or PC that the runner-up and the last bridge are designated for.
    expect(bpdus).toHaveLength(5 * 5);
    expect(engine.now).toBe(simTime(110_000));
  });
});

describe('the default fast timers', () => {
  /** PC1 and PC2 on one switch. */
  function pcSwitchPc() {
    const lab = labBuilder();
    const sw = lab.switch('SW1');
    const pc1 = lab.host('pc', 'PC1', '10.0.0.1/24');
    const pc2 = lab.host('pc', 'PC2', '10.0.0.2/24');
    lab.connect(pc1, 'FastEthernet0', sw, 'FastEthernet0/1');
    lab.connect(pc2, 'FastEthernet0', sw, 'FastEthernet0/2');
    const engine = createEngine({ seed: 1, stacks: STACKS, linkDelay: ms(1) });
    const sim = createSimService({ engine, frames: { now: () => 0, request: () => {} } });
    sim.load(lab.topology);
    const ping = () => {
      const events: PingEvent[] = [];
      const started = sim.ping(pc1, ip('10.0.0.2'), { count: 1, timeoutMs: 500 }, (event) =>
        events.push(event),
      );
      if (!started.ok) throw new Error(started.error);
      while (!events.some((event) => event.kind === 'summary')) engine.step();
      return events.at(-1);
    };
    return { engine, ping };
  }

  it('lets one PC ping another across a switch within 5 s of the lab loading, and not before', () => {
    const { engine, ping } = pcSwitchPc();

    engine.runUntil(simTime(3_000));
    expect(ping()).toMatchObject({ kind: 'summary', sent: 1, received: 0 });

    engine.runUntil(simTime(CONVERGED));
    expect(ping()).toMatchObject({ kind: 'summary', sent: 1, received: 1 });
    expect(engine.now).toBeLessThan(simTime(5_000));
  });

  it('keeps every bridge in a line of 7 switches on the root at one end', () => {
    const lab = labBuilder();
    const line = Array.from({ length: 7 }, (_, n) => lab.switch(`SW${n + 1}`));
    for (const [n, id] of line.slice(1).entries()) {
      lab.connect(line[n]!, 'GigabitEthernet0/2', id, 'GigabitEthernet0/1');
    }
    const first = lab.device(line[0]!);
    if (first.kind !== 'switch') throw new Error('not a switch');
    const stpPriorities = { [VLAN1]: BridgePriority.parse(4096) };
    const root = { ...first, config: { ...first.config, stpPriorities } };
    const topology = { ...lab.topology, devices: { ...lab.topology.devices, [root.id]: root } };
    const engine = createEngine({ seed: 1, stacks: STACKS, linkDelay: ms(1) });
    const sim = createSimService({ engine, frames: { now: () => 0, request: () => {} } });
    sim.load(topology);
    engine.runUntil(simTime(10_000));
    const mark = engine.log.lastId;

    engine.runUntil(simTime(70_000));

    const elections = engine.log
      .since(mark)
      .filter((event) => event.kind === 'note' && event.text.includes('root'));
    expect(elections).toEqual([]);
    const far = sim.spanningTree(line.at(-1)!);
    expect(far.ok && far.value[0]?.rootCost).toBe(6 * 4);
  });
});

describe('changing the timers setting while the lab runs', () => {
  it("moves every bridge to the IOS timers by the root's next hello, then holds a port for 30 s", () => {
    const lab = triangle();
    const { engine, root, middle, last, tree, ports, blocked, runFor, linkBetween, unplug } = lab;
    runFor(CONVERGED);
    const before = blocked();

    engine.applyPatch(timersPatch('ios'));
    expect(tree(root).times).toEqual(IOS);
    expect(tree(last).times).toEqual(FAST);
    expect(tree(last).bridgeTimes).toEqual(IOS);
    // The hello leaves the root a hello time later and takes 2 ms to cross two hops.
    runFor(FAST.hello * 1000 + 2);
    for (const id of [root, middle, last]) expect(tree(id).times).toEqual(IOS);
    expect(blocked()).toEqual(before);

    const standby = lab.portToward(last, middle);
    unplug(linkBetween(last, root));
    expect(ports(last)).toContain(`${standby} root listening`);
    runFor(STP_CONVERGED_IOS - 1);
    expect(ports(last)).toContain(`${standby} root learning`);
    runFor(1);
    expect(ports(last)).toContain(`${standby} root forwarding`);
  });

  it('lets timers already running finish, then runs the next state on the new forward delay', () => {
    const { engine, root, ports, runFor, portToward, middle } = triangle({ timers: 'ios' });
    const toMiddle = portToward(root, middle);
    runFor(5_000);

    engine.applyPatch(timersPatch('fast'));
    runFor(9_999);
    expect(ports(root)).toContain(`${toMiddle} designated listening`);
    runFor(1);
    expect(ports(root)).toContain(`${toMiddle} designated learning`);
    runFor(FAST.forwardDelay * 1000);
    expect(ports(root)).toContain(`${toMiddle} designated forwarding`);
  });

  it('undoes the change when Simulation mode steps back past it, and redoes it stepping forward', () => {
    const { sim, root, tree } = triangle();
    sim.setMode('simulation');
    sim.step();

    sim.applyPatch(timersPatch('ios'));
    expect(tree(root).bridgeTimes).toEqual(IOS);
    sim.step();

    while (sim.stepBack());
    expect(tree(root).bridgeTimes).toEqual(FAST);
    expect(tree(root).times).toEqual(FAST);
    sim.step();
    expect(tree(root).bridgeTimes).toEqual(IOS);
  });
});
