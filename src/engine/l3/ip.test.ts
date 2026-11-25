import { describe, expect, it } from 'vitest';
import type { DeviceId, StaticRoute, Topology } from '@/model';
import type { PingEvent } from '../api';
import { ms, simTime } from '../core/time';
import { createEngine, type Engine } from '../engine';
import type { EventId } from '../events';
import { createSimService } from '../service';
import { STACKS } from '../stacks';
import { ip, labBuilder, routedLab, staticRoute } from '../testing';

function simulate(topology: Topology) {
  const engine = createEngine({ seed: 1, stacks: STACKS, linkDelay: ms(1) });
  const sim = createSimService({ engine, frames: { now: () => 0, request: () => {} } });
  sim.load(topology);

  /** Starts a ping. Its events land in the returned array as the engine runs. */
  const startPing = (from: DeviceId, target: string, { count = 4, timeoutMs = 1000 } = {}) => {
    const events: PingEvent[] = [];
    const started = sim.ping(from, ip(target), { count, timeoutMs }, (event) => events.push(event));
    if (!started.ok) throw new Error(`ping did not start: ${started.error}`);
    return events;
  };
  /** Pings and runs the simulation until the ping's summary arrives. */
  const ping = (
    from: DeviceId,
    target: string,
    options?: { count?: number; timeoutMs?: number },
  ) => {
    const events = startPing(from, target, options);
    while (!events.some((event) => event.kind === 'summary') && engine.nextTime() !== undefined) {
      engine.step();
    }
    return events;
  };
  const value = <T>(result: { ok: true; value: T } | { ok: false; error: string }): T => {
    if (!result.ok) throw new Error(result.error);
    return result.value;
  };
  return { engine, sim, ping, startPing, value };
}

const replies = (events: PingEvent[]) => events.filter((event) => event.kind !== 'summary');
const summary = (events: PingEvent[]) => events.find((event) => event.kind === 'summary');

function arpRequestsFrom(engine: Engine, device: DeviceId) {
  return engine.log
    .since(0 as EventId)
    .filter(
      (event) =>
        event.kind === 'frame' &&
        event.from.device === device &&
        event.frame.kind === 'ethernet' &&
        event.frame.payload.kind === 'arp' &&
        event.frame.payload.op === 'request',
    ).length;
}

/** PC1 192.168.1.10, PC2 192.168.1.20 and PC3 192.168.1.30 on SW1. */
function oneLan() {
  const lab = labBuilder();
  const sw1 = lab.switch('SW1');
  const [pc1, pc2, pc3] = [1, 2, 3].map((n) => {
    const pc = lab.host('pc', `PC${n}`, `192.168.1.${n}0/24`);
    lab.connect(pc, 'FastEthernet0', sw1, `FastEthernet0/${n}`);
    return pc;
  }) as [DeviceId, DeviceId, DeviceId];
  return { lab, sw1, pc1, pc2, pc3 };
}

/**
 * PC1 192.168.1.10 behind R1, PC2 192.168.2.10 behind R2, and the routers joined on 10.0.12.0/30
 * by a serial cable or an Ethernet one.
 */
function twoRouters({
  between,
  r1Routes,
  r2Routes,
}: {
  between: 'serial' | 'ethernet';
  r1Routes: StaticRoute[];
  r2Routes: StaticRoute[];
}) {
  const lab = labBuilder();
  const core = between === 'serial' ? 'Serial0/0/0' : 'GigabitEthernet0/2';
  const pc1 = lab.host('pc', 'PC1', '192.168.1.10/24', '192.168.1.1');
  const pc2 = lab.host('pc', 'PC2', '192.168.2.10/24', '192.168.2.1');
  const r1 = lab.router(
    'R1',
    { 'GigabitEthernet0/0': '192.168.1.1/24', [core]: '10.0.12.1/30' },
    r1Routes,
  );
  const r2 = lab.router(
    'R2',
    { 'GigabitEthernet0/0': '192.168.2.1/24', [core]: '10.0.12.2/30' },
    r2Routes,
  );
  lab.connect(pc1, 'FastEthernet0', r1, 'GigabitEthernet0/0');
  lab.connect(r1, core, r2, core);
  lab.connect(pc2, 'FastEthernet0', r2, 'GigabitEthernet0/0');
  return { lab, pc1, pc2, r1, r2 };
}

describe('ping on one LAN', () => {
  it('gets every reply, with the first held while ARP resolves the peer rather than lost', () => {
    const { lab, pc1 } = oneLan();
    const { ping } = simulate(lab.topology);

    const events = ping(pc1, '192.168.1.20');

    const reply = { kind: 'reply', from: '192.168.1.20', bytes: 32, ttl: 128 };
    expect(replies(events)).toEqual([
      // ARP request and reply, then the echo, each two 1 ms links each way.
      { ...reply, seq: 1, timeMs: 8 },
      { ...reply, seq: 2, timeMs: 4 },
      { ...reply, seq: 3, timeMs: 4 },
      { ...reply, seq: 4, timeMs: 4 },
    ]);
    expect(summary(events)).toEqual({
      kind: 'summary',
      target: '192.168.1.20',
      sent: 4,
      received: 4,
      rtt: { minMs: 4, avgMs: 5, maxMs: 8 },
    });
  });

  it('resolves the peer with one ARP exchange, and both ends cache it', () => {
    const { lab, pc1, pc2 } = oneLan();
    const { engine, sim, ping, value } = simulate(lab.topology);
    const macOf = (id: DeviceId) => {
      const port = lab.device(id).ports[0]!;
      return port.kind === 'serial' ? undefined : port.mac;
    };

    ping(pc1, '192.168.1.20');
    ping(pc1, '192.168.1.20');

    expect(arpRequestsFrom(engine, pc1)).toBe(1);
    expect(arpRequestsFrom(engine, pc2)).toBe(0);
    expect(value(sim.arpTable(pc1))).toMatchObject([
      { kind: 'interface', address: '192.168.1.10', mac: macOf(pc1), interface: 'FastEthernet0' },
      { kind: 'dynamic', address: '192.168.1.20', mac: macOf(pc2), interface: 'FastEthernet0' },
    ]);
    expect(value(sim.arpTable(pc2))).toMatchObject([
      { kind: 'dynamic', address: '192.168.1.10', mac: macOf(pc1) },
      { kind: 'interface', address: '192.168.1.20', mac: macOf(pc2) },
    ]);
  });

  it('asks again once a host has gone 2 minutes without refreshing the entry', () => {
    const { lab, pc1 } = oneLan();
    const { engine, ping } = simulate(lab.topology);

    ping(pc1, '192.168.1.20', { count: 1 });
    engine.runUntil(simTime(engine.now + 119_000));
    ping(pc1, '192.168.1.20', { count: 1 });
    expect(arpRequestsFrom(engine, pc1)).toBe(1);

    engine.runUntil(simTime(engine.now + 120_000));
    ping(pc1, '192.168.1.20', { count: 1 });
    expect(arpRequestsFrom(engine, pc1)).toBe(2);
  });

  it('answers a ping to its own address without touching the wire', () => {
    const { lab, pc1 } = oneLan();
    const { engine, ping } = simulate(lab.topology);
    const mark = engine.log.lastId;

    const events = ping(pc1, '192.168.1.10', { count: 2 });

    expect(replies(events)).toMatchObject([
      { kind: 'reply', seq: 1, from: '192.168.1.10', timeMs: 0, ttl: 128 },
      { kind: 'reply', seq: 2, from: '192.168.1.10', timeMs: 0, ttl: 128 },
    ]);
    expect(engine.log.since(mark).filter((event) => event.kind === 'frame')).toEqual([]);
  });

  it('times out on a powered-off host, after ARP gives up on it', () => {
    const { lab, pc1, pc2 } = oneLan();
    const { engine, ping } = simulate(lab.topology);
    engine.applyPatch({ devices: { [pc2]: { ...lab.device(pc2), powered: false } }, links: {} });

    const events = ping(pc1, '192.168.1.20');

    expect(replies(events)).toEqual([1, 2, 3, 4].map((seq) => ({ kind: 'timeout', seq })));
    expect(summary(events)).toEqual({
      kind: 'summary',
      target: '192.168.1.20',
      sent: 4,
      received: 0,
    });
    expect(arpRequestsFrom(engine, pc1)).toBe(4);
    const notes = engine.log
      .since(0 as EventId)
      .flatMap((event) => (event.kind === 'note' ? [event.text] : []));
    expect(notes).toContain(
      'ARP for 192.168.1.20 went unanswered after 3 tries; dropped 3 packet(s)',
    );
  });
});

describe('ping across a router', () => {
  it('reaches the far LAN through the default gateway, one hop off the TTL', () => {
    const { lab, pc1 } = routedLab();
    const { ping } = simulate(lab.topology);

    const events = ping(pc1, '192.168.2.10');

    expect(replies(events)).toMatchObject(
      [1, 2, 3, 4].map((seq) => ({ kind: 'reply', seq, from: '192.168.2.10', ttl: 127 })),
    );
    expect(summary(events)).toMatchObject({ sent: 4, received: 4 });
  });

  it("reaches both of the router's own addresses", () => {
    const { lab, pc1 } = routedLab();
    const { ping } = simulate(lab.topology);

    expect(replies(ping(pc1, '192.168.1.1', { count: 1 }))).toMatchObject([
      { kind: 'reply', from: '192.168.1.1', ttl: 255 },
    ]);
    expect(replies(ping(pc1, '192.168.2.1', { count: 1 }))).toMatchObject([
      { kind: 'reply', from: '192.168.2.1', ttl: 255 },
    ]);
  });

  it('gets Destination Unreachable from a router with no route', () => {
    const { lab, pc1 } = routedLab();
    const { ping } = simulate(lab.topology);

    const events = ping(pc1, '10.99.0.1');

    expect(replies(events)).toEqual(
      [1, 2, 3, 4].map((seq) => ({
        kind: 'unreachable',
        seq,
        from: '192.168.1.1',
        code: 'network',
      })),
    );
    expect(summary(events)).toEqual({ kind: 'summary', target: '10.99.0.1', sent: 4, received: 0 });
  });

  it('gets Time Exceeded when two static routes point at each other', () => {
    const { lab, pc1 } = twoRouters({
      between: 'ethernet',
      r1Routes: [staticRoute('10.99.0.0/16', '10.0.12.2')],
      r2Routes: [
        staticRoute('10.99.0.0/16', '10.0.12.1'),
        staticRoute('192.168.1.0/24', '10.0.12.1'),
      ],
    });
    const { engine, ping } = simulate(lab.topology);

    const events = ping(pc1, '10.99.0.1', { count: 1 });

    // PC1 starts at TTL 128, so R2 receives the odd TTLs and holds the packet when it reaches 1.
    expect(replies(events)).toEqual([{ kind: 'ttl-expired', seq: 1, from: '10.0.12.2' }]);
    const bounces = engine.log
      .since(0 as EventId)
      .filter(
        (event) =>
          event.kind === 'frame' &&
          event.frame.kind === 'ethernet' &&
          event.frame.payload.kind === 'ipv4' &&
          event.frame.payload.dst === '10.99.0.1',
      );
    expect(bounces).toHaveLength(128);
  });

  it('crosses a serial link on an exit-interface route one way and a default route back', () => {
    const { lab, pc1 } = twoRouters({
      between: 'serial',
      r1Routes: [staticRoute('192.168.2.0/24', 'Serial0/0/0')],
      r2Routes: [staticRoute('0.0.0.0/0', '10.0.12.1')],
    });
    const { ping } = simulate(lab.topology);

    expect(replies(ping(pc1, '192.168.2.10'))).toMatchObject(
      [1, 2, 3, 4].map((seq) => ({ kind: 'reply', seq, from: '192.168.2.10', ttl: 126 })),
    );
  });

  it('crosses Ethernet on an exit-interface route through the next router answering ARP for it', () => {
    const { lab, pc1 } = twoRouters({
      between: 'ethernet',
      r1Routes: [staticRoute('192.168.2.0/24', 'GigabitEthernet0/2')],
      r2Routes: [staticRoute('192.168.1.0/24', '10.0.12.1')],
    });
    const { ping } = simulate(lab.topology);

    expect(summary(ping(pc1, '192.168.2.10'))).toMatchObject({ sent: 4, received: 4 });
  });

  it('never forwards through a host, even one a router uses as its next hop', () => {
    const { lab, pc1 } = routedLab([staticRoute('10.99.0.0/16', '192.168.2.10')]);
    const { ping } = simulate(lab.topology);

    // Forwarding, PC2 would send it back to its gateway R1, and the loop would end in Time Exceeded.
    expect(replies(ping(pc1, '10.99.0.1', { count: 1 }))).toEqual([{ kind: 'timeout', seq: 1 }]);
  });

  it('forwards on the longest matching prefix', () => {
    const { lab, pc1 } = twoRouters({
      between: 'ethernet',
      // 10.1.0.1 goes to a host on 192.168.1.0/24 that does not exist, so ARP for it fails.
      r1Routes: [
        staticRoute('10.0.0.0/8', '192.168.1.99'),
        staticRoute('10.99.0.0/16', '10.0.12.2'),
      ],
      r2Routes: [staticRoute('192.168.1.0/24', '10.0.12.1')],
    });
    const { ping } = simulate(lab.topology);

    expect(replies(ping(pc1, '10.99.0.1', { count: 1 }))).toEqual([
      { kind: 'unreachable', seq: 1, from: '10.0.12.2', code: 'network' },
    ]);
    expect(replies(ping(pc1, '10.1.0.1', { count: 1 }))).toEqual([{ kind: 'timeout', seq: 1 }]);
  });
});

describe('routes', () => {
  it("lists a router's connected, local and usable static routes by network", () => {
    const { lab, r1 } = routedLab([
      staticRoute('10.0.0.0/8', '192.168.2.254'),
      staticRoute('172.16.0.0/16', '203.0.113.1'),
    ]);
    const { sim, value } = simulate(lab.topology);

    const listed = value(sim.routes(r1)).map((route) => [
      route.source,
      `${route.prefix.address}/${route.prefix.prefixLength}`,
    ]);
    expect(listed).toEqual([
      ['static', '10.0.0.0/8'],
      ['connected', '192.168.1.0/24'],
      ['local', '192.168.1.1/32'],
      ['connected', '192.168.2.0/24'],
      ['local', '192.168.2.1/32'],
    ]);
  });

  it("lists a host's subnet and its default gateway", () => {
    const { lab, pc1 } = routedLab();
    const { sim, value } = simulate(lab.topology);

    expect(value(sim.routes(pc1))).toEqual([
      {
        source: 'static',
        prefix: { address: '0.0.0.0', prefixLength: 0 },
        distance: 1,
        nextHop: { kind: 'address', address: '192.168.1.1' },
      },
      {
        source: 'connected',
        prefix: { address: '192.168.1.0', prefixLength: 24 },
        interface: 'FastEthernet0',
      },
    ]);
  });

  it('drops the connected route of an interface whose link goes down', () => {
    const { lab, r1, sw2 } = routedLab();
    const { engine, sim, value } = simulate(lab.topology);

    engine.applyPatch({ devices: { [sw2]: { ...lab.device(sw2), powered: false } }, links: {} });

    expect(value(sim.routes(r1)).map((route) => route.prefix.address)).toEqual([
      '192.168.1.0',
      '192.168.1.1',
    ]);
  });
});

describe('SimAPI.ping', () => {
  it('says why a device cannot ping', () => {
    const { lab, pc1, pc2 } = oneLan();
    const { engine, sim } = simulate(lab.topology);
    engine.applyPatch({ devices: { [pc2]: { ...lab.device(pc2), powered: false } }, links: {} });
    const options = { count: 1, timeoutMs: 1000 };

    expect(sim.ping('dev_gone' as DeviceId, ip('192.168.1.10'), options, () => {})).toEqual({
      ok: false,
      error: 'unknown-device',
    });
    expect(sim.ping(pc2, ip('192.168.1.10'), options, () => {})).toEqual({
      ok: false,
      error: 'powered-off',
    });
    expect(sim.ping(pc1, ip('192.168.1.20'), options, () => {})).toEqual({
      ok: true,
      value: undefined,
    });
  });

  it('rejects a count below one and a timeout that is not positive', () => {
    const { lab, pc1 } = oneLan();
    const { sim } = simulate(lab.topology);

    expect(() =>
      sim.ping(pc1, ip('192.168.1.20'), { count: 0, timeoutMs: 1000 }, () => {}),
    ).toThrow(RangeError);
    expect(() => sim.ping(pc1, ip('192.168.1.20'), { count: 1, timeoutMs: 0 }, () => {})).toThrow(
      RangeError,
    );
  });

  it('ends with a summary when the pinging device powers off mid-ping', () => {
    const { lab, pc1 } = oneLan();
    const { engine, startPing } = simulate(lab.topology);

    const events = startPing(pc1, '192.168.1.20');
    engine.runUntil(simTime(1500));
    engine.applyPatch({ devices: { [pc1]: { ...lab.device(pc1), powered: false } }, links: {} });

    expect(events.map((event) => event.kind)).toEqual(['reply', 'reply', 'summary']);
    expect(summary(events)).toMatchObject({ sent: 2, received: 2 });
  });
});
