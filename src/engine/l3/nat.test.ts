import { describe, expect, it } from 'vitest';
import type { AccessList, DeviceId, NatConfig, PortId, RouterConfig } from '@/model';
import type { FetchEvent, PingEvent, TraceEvent } from '../api';
import { after, ms, type SimDuration } from '../core/time';
import { createEngine } from '../engine';
import { createSimService } from '../service';
import { STACKS } from '../stacks';
import { TCP_WINDOW, type TcpSegment } from '../tcp';
import { ip, labBuilder, staticRoute, STP_CONVERGED } from '../testing';
import type { IpContext } from './context';
import { ipModule } from './ip';
import { clearNat, natTranslations, NAT_TIMEOUTS, type NatTranslationEntry } from './nat';
import { originate } from './output';
import { udp } from './udp';

const insideLan: AccessList = {
  type: 'standard',
  entries: [
    {
      kind: 'rule',
      action: 'permit',
      source: { address: ip('10.0.0.0'), wildcard: ip('0.0.0.255') },
    },
  ],
};

/**
 * PC1 10.0.0.10 and PC2 10.0.0.11 on SW1, inside R1's Gi0/0. R1's Gi0/1, 203.0.113.1, is outside,
 * toward R2, whose Gi0/1 LAN has Server 198.51.100.10. R2 knows no way to 10.0.0.0/8, so only
 * translated packets get answers. It routes 192.0.2.0/24, where the pools and static mappings
 * live, back to R1.
 */
function natLab(nat: NatConfig) {
  const lab = labBuilder();
  const sw1 = lab.switch('SW1');
  const pc1 = lab.host('pc', 'PC1', '10.0.0.10/24', '10.0.0.1');
  const pc2 = lab.host('pc', 'PC2', '10.0.0.11/24', '10.0.0.1');
  const r1 = lab.router(
    'R1',
    { 'GigabitEthernet0/0': '10.0.0.1/24', 'GigabitEthernet0/1': '203.0.113.1/24' },
    [staticRoute('0.0.0.0/0', '203.0.113.2')],
  );
  const r2 = lab.router(
    'R2',
    { 'GigabitEthernet0/0': '203.0.113.2/24', 'GigabitEthernet0/1': '198.51.100.1/24' },
    [staticRoute('192.0.2.0/24', '203.0.113.1')],
  );
  const server = lab.host('server', 'Server', '198.51.100.10/24', '198.51.100.1');
  lab.edit(server, (device) =>
    device.kind === 'server'
      ? {
          ...device,
          config: {
            ...device.config,
            services: {
              dns: { enabled: false, records: [] },
              http: { enabled: true, indexHtml: '<h1>Outside</h1>' },
            },
          },
        }
      : device,
  );
  lab.connect(pc1, 'FastEthernet0', sw1, 'FastEthernet0/1');
  lab.connect(pc2, 'FastEthernet0', sw1, 'FastEthernet0/2');
  lab.connect(sw1, 'GigabitEthernet0/1', r1, 'GigabitEthernet0/0');
  lab.connect(r1, 'GigabitEthernet0/1', r2, 'GigabitEthernet0/0');
  lab.connect(r2, 'GigabitEthernet0/1', server, 'FastEthernet0');
  lab.edit(r1, (device) => {
    if (device.kind !== 'router') return device;
    const role = (port: string, nat: 'inside' | 'outside') => ({
      [port]: { ...device.config.interfaces[port as PortId]!, nat },
    });
    const config: RouterConfig = {
      ...device.config,
      accessLists: { '1': insideLan },
      nat,
      interfaces: {
        ...device.config.interfaces,
        ...role('GigabitEthernet0/0', 'inside'),
        ...role('GigabitEthernet0/1', 'outside'),
      },
    };
    return { ...device, config };
  });

  const engine = createEngine({ seed: 1, stacks: STACKS, linkDelay: ms(1) });
  const sim = createSimService({ engine, frames: { now: () => 0, request: () => {} } });
  sim.load(lab.topology);
  engine.runUntil(STP_CONVERGED);

  /** Runs the simulation `duration` ms on. */
  const later = (duration: number) => engine.runUntil(after(engine.now, duration as SimDuration));
  const run = <T>(done: (events: T[]) => boolean, start: (listen: (e: T) => void) => unknown) => {
    const events: T[] = [];
    start((event) => events.push(event));
    while (!done(events) && engine.nextTime() !== undefined) engine.step();
    return events;
  };
  const ping = (from: DeviceId, target: string) =>
    run<PingEvent>(
      (events) => events.some((e) => e.kind === 'summary'),
      (listen) => sim.ping(from, ip(target), { count: 4, timeoutMs: 1000 }, listen),
    ).find((e) => e.kind === 'summary');
  /** Loads http://198.51.100.10/ from `from` and returns how the load ended. */
  const browse = (from: DeviceId) =>
    run<FetchEvent>(
      (events) => events.some((e) => e.kind === 'response' || e.kind === 'failed'),
      (listen) => sim.browse(from, { host: '198.51.100.10', port: 80, path: '/' }, listen),
    ).at(-1);
  const trace = (from: DeviceId, target: string) =>
    run<TraceEvent>(
      (events) => events.some((e) => e.kind === 'done'),
      (listen) =>
        sim.traceroute(from, ip(target), { maxHops: 5, probesPerHop: 1, timeoutMs: 1000 }, listen),
    );
  const onR1 = <T>(read: (ctx: IpContext) => T): T => {
    const result = engine.withModule(r1, ipModule, read);
    if (!result.ok) throw new Error(result.error);
    return result.value;
  };
  const translations = (): NatTranslationEntry[] => onR1(natTranslations);
  return { engine, sim, ping, browse, trace, later, translations, onR1, pc1, pc2, server };
}

const NO_NAT: NatConfig = { pools: {}, statics: [], dynamic: [] };

describe('PAT', () => {
  const pat: NatConfig = {
    ...NO_NAT,
    dynamic: [
      {
        acl: '1',
        to: { kind: 'interface', interface: 'GigabitEthernet0/1' as PortId },
        overload: true,
      },
    ],
  };

  it('lets two inside hosts share the outside address, each on its own port', () => {
    const { ping, translations, pc1, pc2 } = natLab(pat);

    // Each PC's first ping uses echo identifier 1, so the second must move to another port.
    expect(ping(pc1, '198.51.100.10')).toMatchObject({ sent: 4, received: 4 });
    expect(ping(pc2, '198.51.100.10')).toMatchObject({ sent: 4, received: 4 });

    expect(translations()).toEqual([
      {
        protocol: 1,
        insideGlobal: { address: '203.0.113.1', port: 1 },
        insideLocal: { address: '10.0.0.10', port: 1 },
        outside: { address: '198.51.100.10', port: 1 },
      },
      {
        protocol: 1,
        insideGlobal: { address: '203.0.113.1', port: 1024 },
        insideLocal: { address: '10.0.0.11', port: 1 },
        outside: { address: '198.51.100.10', port: 1024 },
      },
    ]);
  });

  it('translates TCP: two PCs browse the server through one address on different ports', () => {
    const { browse, translations, pc1, pc2 } = natLab(pat);

    expect(browse(pc1)).toMatchObject({ kind: 'response', response: { status: 200 } });
    expect(browse(pc2)).toMatchObject({ kind: 'response', response: { status: 200 } });

    const tcp = translations().filter((t) => t.protocol === 6);
    expect(tcp.map((t) => t.insideLocal.address)).toEqual(['10.0.0.10', '10.0.0.11']);
    expect(tcp.every((t) => t.insideGlobal.address === '203.0.113.1')).toBe(true);
    expect(tcp.every((t) => t.outside?.port === 80)).toBe(true);
    expect(new Set(tcp.map((t) => t.insideGlobal.port)).size).toBe(2);
  });

  it('moves a TCP connection to port 1024 when another host already holds its port', () => {
    const { engine, browse, translations, later, pc1, pc2 } = natLab(pat);
    browse(pc1);
    const [first] = translations().filter((t) => t.protocol === 6);
    const port = first!.insideLocal.port!;
    expect(first!.insideGlobal.port).toBe(port);

    // PC2 opens a connection from the very port PC1's connection kept on 203.0.113.1.
    const syn: TcpSegment = {
      kind: 'tcp',
      srcPort: port,
      dstPort: 80,
      seq: 1000,
      ack: 0,
      flags: { syn: true, ack: false, fin: false, rst: false, psh: false },
      window: TCP_WINDOW,
    };
    engine.withModule(pc2, ipModule, (ctx) => originate(ctx, ip('198.51.100.10'), syn));
    later(100);

    expect(translations().filter((t) => t.protocol === 6)).toContainEqual({
      protocol: 6,
      insideGlobal: { address: '203.0.113.1', port: 1024 },
      insideLocal: { address: '10.0.0.11', port },
      outside: { address: '198.51.100.10', port: 80 },
    });
  });

  it('translates UDP ports, and the ICMP errors routers send back about translated packets', () => {
    const { engine, trace, later, translations, pc1 } = natLab(pat);

    engine.withModule(pc1, ipModule, (ctx) =>
      originate(
        ctx,
        ip('198.51.100.10'),
        udp(5000, 69, { kind: 'rip', command: 'request', version: 2 }),
      ),
    );
    later(1000);
    expect(translations()).toContainEqual({
      protocol: 17,
      insideGlobal: { address: '203.0.113.1', port: 5000 },
      insideLocal: { address: '10.0.0.10', port: 5000 },
      outside: { address: '198.51.100.10', port: 69 },
    });

    // R2's Time Exceeded goes to 203.0.113.1 and still reaches PC1.
    const hops = trace(pc1, '198.51.100.10').flatMap((e) => ('from' in e ? [e.from] : []));
    expect(hops).toEqual(['10.0.0.1', '203.0.113.2', '198.51.100.10']);
  });

  it('forgets an ICMP translation a minute after its last packet, and keeps UDP longer', () => {
    const { engine, ping, later, translations, pc1 } = natLab(pat);
    ping(pc1, '198.51.100.10');
    engine.withModule(pc1, ipModule, (ctx) =>
      originate(
        ctx,
        ip('198.51.100.10'),
        udp(5000, 69, { kind: 'rip', command: 'request', version: 2 }),
      ),
    );
    later(10);
    expect(translations().map((t) => t.protocol)).toEqual([1, 17]);

    later(NAT_TIMEOUTS[1]);
    expect(translations().map((t) => t.protocol)).toEqual([17]);
    later(NAT_TIMEOUTS[17]);
    expect(translations()).toEqual([]);
  });

  it('clears every dynamic translation on request', () => {
    const { ping, translations, onR1, pc1, pc2 } = natLab(pat);
    ping(pc1, '198.51.100.10');
    ping(pc2, '198.51.100.10');

    expect(onR1(clearNat)).toBe(2);
    expect(translations()).toEqual([]);
  });
});

describe('static NAT', () => {
  const statics: NatConfig = {
    ...NO_NAT,
    statics: [{ local: ip('10.0.0.10'), global: ip('192.0.2.10') }],
  };

  it('gives one inside host a fixed outside address that outside hosts can reach', () => {
    const { ping, translations, pc1, pc2, server } = natLab(statics);

    expect(ping(server, '192.0.2.10')).toMatchObject({ received: 4 });
    expect(ping(pc1, '198.51.100.10')).toMatchObject({ received: 4 });
    // PC2 has no mapping and no rule covers it, so it leaves untranslated and R2 cannot answer.
    expect(ping(pc2, '198.51.100.10')).toMatchObject({ received: 0 });
    expect(translations()).toEqual([
      { insideGlobal: { address: '192.0.2.10' }, insideLocal: { address: '10.0.0.10' } },
    ]);
  });
});

describe('dynamic NAT', () => {
  const onePool: NatConfig = {
    pools: { OUT: { first: ip('192.0.2.20'), last: ip('192.0.2.20'), prefixLength: 24 as never } },
    statics: [],
    dynamic: [{ acl: '1', to: { kind: 'pool', pool: 'OUT' }, overload: false }],
  };

  it('lends each inside host a pool address, and drops a host that finds the pool empty', () => {
    const { engine, ping, translations, pc1, pc2 } = natLab(onePool);

    expect(ping(pc1, '198.51.100.10')).toMatchObject({ received: 4 });
    const mark = engine.log.lastId;
    expect(ping(pc2, '198.51.100.10')).toMatchObject({ received: 0 });

    expect(translations()).toEqual([
      { insideGlobal: { address: '192.0.2.20' }, insideLocal: { address: '10.0.0.10' } },
    ]);
    expect(
      engine.log
        .since(mark)
        .filter((e) => e.kind === 'note')
        .map((e) => e.text),
    ).toContain('Dropped a packet from 10.0.0.11: NAT pool OUT has no address or port left');
  });

  // A day of simulated time, with every router and switch advertising CDP every 5 s.
  it('frees the address once the binding times out', { timeout: 20_000 }, () => {
    const { ping, later, translations, pc1, pc2 } = natLab(onePool);
    ping(pc1, '198.51.100.10');

    later(NAT_TIMEOUTS.binding);
    expect(translations()).toEqual([]);
    expect(ping(pc2, '198.51.100.10')).toMatchObject({ received: 4 });
  });

  it('answers ARP for a pool in the outside subnet, so replies find their way back', () => {
    const { ping, pc1 } = natLab({
      ...onePool,
      pools: {
        OUT: { first: ip('203.0.113.50'), last: ip('203.0.113.51'), prefixLength: 24 as never },
      },
    });
    expect(ping(pc1, '198.51.100.10')).toMatchObject({ received: 4 });
  });
});
