import { describe, expect, it } from 'vitest';
import type { DeviceId, Ipv6StaticRoute, PortId, RouterConfig, Topology } from '@/model';
import {
  eui64Address,
  ipv6MulticastMac,
  linkLocalOf,
  readIpv6,
  readIpv6Cidr,
  solicitedNode,
} from '@/model/ipv6';
import type { Ipv6Status, PingEvent, TraceEvent } from '../api';
import { ms, simTime } from '../core/time';
import { createEngine, type Engine } from '../engine';
import type { EventId, FrameEvent } from '../events';
import type { EthernetFrame } from '../pdu';
import type { Ipv6Packet } from '../pdu6';
import { createSimService } from '../service';
import { STACKS } from '../stacks';
import { labBuilder, STP_CONVERGED } from '../testing';

const v6 = (text: string) => readIpv6(text)!;
const cidr6 = (text: string) => readIpv6Cidr(text)!;

type Lab = ReturnType<typeof labBuilder>;

type Ipv6Port = { addresses?: string[]; eui64?: string[]; linkLocal?: string; autoconfig?: true };

/** A router whose named interfaces come up with these IPv6 settings, and nothing else. */
function router6(
  lab: Lab,
  name: string,
  ports: Record<string, Ipv6Port>,
  { routing = true, routes = [] as Ipv6StaticRoute[] } = {},
): DeviceId {
  const id = lab.router(name, {});
  lab.edit(id, (device) => {
    if (device.kind !== 'router') return device;
    const interfaces = { ...device.config.interfaces };
    for (const [port, settings] of Object.entries(ports)) {
      interfaces[port as PortId] = {
        shutdown: false,
        ipv6: {
          addresses: [
            ...(settings.addresses ?? []).map((text) => ({ cidr: cidr6(text), eui64: false })),
            ...(settings.eui64 ?? []).map((text) => ({ cidr: cidr6(text), eui64: true })),
          ],
          ...(settings.linkLocal && { linkLocal: v6(settings.linkLocal) }),
          ...(settings.autoconfig && { autoconfig: true }),
        },
      };
    }
    const config: RouterConfig = {
      ...device.config,
      interfaces,
      ...(routing && { ipv6UnicastRouting: true }),
      ipv6StaticRoutes: routes,
    };
    return { ...device, config };
  });
  return id;
}

/** A PC with no IPv4, set to SLAAC, or to a static IPv6 address and gateway. */
function pc6(lab: Lab, name: string, address?: string, gateway?: string): DeviceId {
  const id = lab.host('pc', name);
  lab.edit(id, (device) => {
    if (device.kind !== 'pc') return device;
    const ipv6 =
      address === undefined
        ? ({ mode: 'auto' } as const)
        : {
            mode: 'static' as const,
            address: cidr6(address),
            ...(gateway && { gateway: v6(gateway) }),
          };
    return { ...device, config: { ...device.config, ipv6 } };
  });
  return id;
}

const route6 = (prefix: string, via: string): Ipv6StaticRoute => ({
  prefix: cidr6(prefix),
  nextHop: readIpv6(via)
    ? { kind: 'address', address: v6(via) }
    : { kind: 'interface', interface: via as PortId },
});

function simulate(topology: Topology, settle = STP_CONVERGED) {
  const engine = createEngine({ seed: 1, stacks: STACKS, linkDelay: ms(1) });
  const sim = createSimService({ engine, frames: { now: () => 0, request: () => {} } });
  sim.load(topology);
  engine.runUntil(settle);
  const run = (done: () => boolean) => {
    while (!done() && engine.nextTime() !== undefined) engine.step();
  };
  const ping = (from: DeviceId, target: string, count = 4) => {
    const events: PingEvent[] = [];
    const started = sim.ping(from, v6(target), { count, timeoutMs: 1000 }, (e) => events.push(e));
    if (!started.ok) throw new Error(started.error);
    run(() => events.some((event) => event.kind === 'summary'));
    return events;
  };
  const trace = (from: DeviceId, target: string) => {
    const events: TraceEvent[] = [];
    const options = { maxHops: 30, probesPerHop: 3, timeoutMs: 1000 };
    const started = sim.traceroute(from, v6(target), options, (e) => events.push(e));
    if (!started.ok) throw new Error(started.error);
    run(() => events.some((event) => event.kind === 'done'));
    return events;
  };
  const status = (device: DeviceId): Ipv6Status => {
    const result = sim.ipv6Status(device);
    if (!result.ok) throw new Error(result.error);
    return result.value;
  };
  return { engine, sim, ping, trace, status };
}

const replies = (events: PingEvent[]) =>
  events.flatMap((event) => (event.kind === 'reply' ? [event.from] : []));

/** The IPv6 frames on the wire, as event, frame and packet. */
function ipv6Frames(engine: Engine) {
  return engine.log
    .since(0 as EventId)
    .filter((event): event is FrameEvent => event.kind === 'frame')
    .flatMap((event) => {
      const frame = event.frame;
      if (frame.kind === 'ethernet' && frame.payload.kind === 'ipv6') {
        return [{ event, frame: frame as EthernetFrame, packet: frame.payload as Ipv6Packet }];
      }
      return [];
    });
}

const macOf = (lab: Lab, device: DeviceId) => {
  const port = lab.device(device).ports[0]!;
  if (port.kind === 'serial') throw new Error('no MAC');
  return port.mac;
};

describe('Neighbor Discovery', () => {
  function twoPcs() {
    const lab = labBuilder();
    const sw = lab.switch('SW1');
    const pc1 = pc6(lab, 'PC1', '2001:db8:1::10/64');
    const pc2 = pc6(lab, 'PC2', '2001:db8:1::20/64');
    lab.connect(pc1, 'FastEthernet0', sw, 'FastEthernet0/1');
    lab.connect(pc2, 'FastEthernet0', sw, 'FastEthernet0/2');
    return { lab, pc1, pc2 };
  }

  it('resolves a neighbour with a solicitation to its solicited-node group, then pings it', () => {
    const { lab, pc1, pc2 } = twoPcs();
    const { engine, ping, status } = simulate(lab.topology);
    expect(replies(ping(pc1, '2001:db8:1::20'))).toEqual(Array(4).fill('2001:db8:1::20'));

    const solicitations = ipv6Frames(engine).filter(
      ({ packet }) => packet.payload.type === 'neighbor-solicitation',
    );
    const first = solicitations[0]!;
    expect(first.event.from.device).toBe(pc1);
    expect(first.packet.dst).toBe(solicitedNode(v6('2001:db8:1::20')));
    expect(first.frame.dst).toBe('33:33:ff:00:00:20');
    expect(first.packet.hopLimit).toBe(255);
    expect(first.packet.payload).toMatchObject({
      target: '2001:db8:1::20',
      sourceMac: macOf(lab, pc1),
    });

    const advertisement = ipv6Frames(engine).find(
      ({ packet }) => packet.payload.type === 'neighbor-advertisement',
    )!;
    expect(advertisement.event.from.device).toBe(pc2);
    expect(advertisement.frame.dst).toBe(macOf(lab, pc1));
    expect(advertisement.packet.payload).toMatchObject({
      target: '2001:db8:1::20',
      solicited: true,
      router: false,
      targetMac: macOf(lab, pc2),
    });

    expect(status(pc1).neighbors).toEqual([
      expect.objectContaining({ address: '2001:db8:1::20', mac: macOf(lab, pc2), state: 'REACH' }),
    ]);
  });

  it('pings a neighbour by its link-local address', () => {
    const { lab, pc1, pc2 } = twoPcs();
    const { ping } = simulate(lab.topology);
    const linkLocal = linkLocalOf(macOf(lab, pc2));
    expect(replies(ping(pc1, linkLocal, 2))).toEqual([linkLocal, linkLocal]);
  });

  it('marks a neighbour stale once it has gone unconfirmed for the reachable time', () => {
    const { lab, pc1 } = twoPcs();
    const { engine, ping, status } = simulate(lab.topology);
    ping(pc1, '2001:db8:1::20', 1);
    engine.runUntil(simTime(engine.now + 31_000));
    expect(status(pc1).neighbors[0]?.state).toBe('STALE');
  });

  it('times out a ping to an address nobody on the link has', () => {
    const { lab, pc1 } = twoPcs();
    const { ping } = simulate(lab.topology);
    const events = ping(pc1, '2001:db8:1::99', 2);
    expect(events.filter((event) => event.kind === 'timeout')).toHaveLength(2);
  });
});

describe('Router advertisements and SLAAC', () => {
  function slaacLan(routing = true) {
    const lab = labBuilder();
    const sw = lab.switch('SW1');
    const r1 = router6(
      lab,
      'R1',
      { 'GigabitEthernet0/0': { addresses: ['2001:db8:1::1/64'], linkLocal: 'fe80::1' } },
      { routing },
    );
    const pc1 = pc6(lab, 'PC1');
    lab.connect(pc1, 'FastEthernet0', sw, 'FastEthernet0/1');
    lab.connect(sw, 'GigabitEthernet0/1', r1, 'GigabitEthernet0/0');
    return { lab, r1, pc1 };
  }

  it('gives a host on automatic an EUI-64 address in the advertised prefix, and the router as its gateway', () => {
    const { lab, pc1 } = slaacLan();
    const { status } = simulate(lab.topology, simTime(12_000));
    const host = status(pc1);
    const address = eui64Address(v6('2001:db8:1::'), macOf(lab, pc1));
    expect(host.interfaces[0]).toMatchObject({
      linkLocal: linkLocalOf(macOf(lab, pc1)),
      addresses: [{ address, prefixLength: 64, origin: 'autoconfig' }],
    });
    expect(host.gateway).toBe('fe80::1');
    expect(host.routes).toContainEqual(
      expect.objectContaining({
        source: 'connected',
        prefix: { address: '2001:db8:1::', prefixLength: 64 },
      }),
    );
  });

  it('sends advertisements to all nodes with the prefix and the router link-local as source', () => {
    const { lab, r1 } = slaacLan();
    const { engine } = simulate(lab.topology, simTime(12_000));
    const ra = ipv6Frames(engine).find(
      ({ packet, event }) =>
        packet.payload.type === 'router-advertisement' && event.from.device === r1,
    )!;
    expect(ra.frame.dst).toBe(ipv6MulticastMac(v6('ff02::1')));
    expect(ra.packet).toMatchObject({ src: 'fe80::1', dst: 'ff02::1', hopLimit: 255 });
    expect(ra.packet.payload).toMatchObject({
      routerLifetime: 1800,
      prefixes: [
        {
          prefix: { address: '2001:db8:1::', prefixLength: 64 },
          onLink: true,
          autonomous: true,
        },
      ],
    });
  });

  it('answers a router solicitation, so a host is configured soon after its port forwards', () => {
    const { lab, pc1 } = slaacLan();
    const { engine, status } = simulate(lab.topology, simTime(9_000));
    expect(status(pc1).interfaces[0]?.addresses).toHaveLength(1);
    const solicitations = ipv6Frames(engine).filter(
      ({ packet }) => packet.payload.type === 'router-solicitation',
    );
    expect(solicitations[0]?.packet.dst).toBe('ff02::2');
    expect(solicitations[0]?.frame.dst).toBe('33:33:00:00:00:02');
  });

  it('sends no advertisements without ipv6 unicast-routing, so the host keeps its link-local only', () => {
    const { lab, pc1 } = slaacLan(false);
    const { engine, status } = simulate(lab.topology, simTime(20_000));
    expect(
      ipv6Frames(engine).some(({ packet }) => packet.payload.type === 'router-advertisement'),
    ).toBe(false);
    expect(status(pc1).interfaces[0]?.addresses).toEqual([]);
    expect(status(pc1).gateway).toBeUndefined();
  });

  it('pings the router across the LAN from the SLAAC address', () => {
    const { lab, pc1 } = slaacLan();
    const { ping } = simulate(lab.topology, simTime(12_000));
    expect(replies(ping(pc1, '2001:db8:1::1', 2))).toEqual(['2001:db8:1::1', '2001:db8:1::1']);
  });

  it('lists the router interface, its routes and its neighbours', () => {
    const { lab, r1, pc1 } = slaacLan();
    const { ping, status } = simulate(lab.topology, simTime(12_000));
    ping(pc1, '2001:db8:1::1', 1);
    const router = status(r1);
    expect(router.routing).toBe(true);
    expect(router.interfaces).toEqual([
      {
        name: 'GigabitEthernet0/0',
        up: true,
        linkLocal: 'fe80::1',
        addresses: [{ address: '2001:db8:1::1', prefixLength: 64, origin: 'manual' }],
        groups: ['ff02::1', 'ff02::2', 'ff02::1:ff00:1'],
      },
    ]);
    expect(router.routes).toEqual([
      {
        source: 'connected',
        prefix: { address: '2001:db8:1::', prefixLength: 64 },
        interface: 'GigabitEthernet0/0',
      },
      {
        source: 'local',
        prefix: { address: '2001:db8:1::1', prefixLength: 128 },
        interface: 'GigabitEthernet0/0',
      },
    ]);
    const address = eui64Address(v6('2001:db8:1::'), macOf(lab, pc1));
    expect(router.neighbors.map((entry) => entry.address)).toContain(address);
  });
});

describe('Forwarding across two routers', () => {
  /** PC1 2001:db8:1::/64 — R1 — 2001:db8:12::/64 — R2 — 2001:db8:2::/64 PC2. */
  function twoRouters({ r2Back = true, serial = false } = {}) {
    const lab = labBuilder();
    const middle = serial ? 'Serial0/0/0' : 'GigabitEthernet0/1';
    const r1 = router6(
      lab,
      'R1',
      {
        'GigabitEthernet0/0': { addresses: ['2001:db8:1::1/64'], linkLocal: 'fe80::1' },
        [middle]: { addresses: ['2001:db8:12::1/64'] },
      },
      { routes: [route6('2001:db8:2::/64', '2001:db8:12::2')] },
    );
    const r2 = router6(
      lab,
      'R2',
      {
        'GigabitEthernet0/0': { addresses: ['2001:db8:2::1/64'], linkLocal: 'fe80::2' },
        [middle]: { addresses: ['2001:db8:12::2/64'] },
      },
      // Out of an interface alone works on a serial link, which has one peer. On Ethernet the
      // router would solicit the destination itself, and IPv6 has no proxy to answer.
      { routes: r2Back ? [route6('2001:db8:1::/64', serial ? middle : '2001:db8:12::1')] : [] },
    );
    const pc1 = pc6(lab, 'PC1', '2001:db8:1::10/64', 'fe80::1');
    const pc2 = pc6(lab, 'PC2', '2001:db8:2::10/64', '2001:db8:2::1');
    lab.connect(pc1, 'FastEthernet0', r1, 'GigabitEthernet0/0');
    lab.connect(r1, middle, r2, middle);
    lab.connect(r2, 'GigabitEthernet0/0', pc2, 'FastEthernet0');
    return { lab, r1, r2, pc1, pc2 };
  }

  it('pings end to end over static routes, with the hop limit counting down', () => {
    const { lab, pc1 } = twoRouters();
    const { ping } = simulate(lab.topology);
    const events = ping(pc1, '2001:db8:2::10');
    expect(replies(events)).toEqual(Array(4).fill('2001:db8:2::10'));
    // PC2 starts at 128 and two routers forward the reply.
    expect(events[0]).toMatchObject({ kind: 'reply', ttl: 126 });
  });

  it('pings end to end over a serial link', () => {
    const { lab, pc1 } = twoRouters({ serial: true });
    const { ping } = simulate(lab.topology);
    expect(replies(ping(pc1, '2001:db8:2::10', 2))).toHaveLength(2);
  });

  it('lists a static route and resolves it through the connected network', () => {
    const { lab, r1 } = twoRouters();
    const { status } = simulate(lab.topology);
    expect(status(r1).routes).toContainEqual({
      source: 'static',
      prefix: { address: '2001:db8:2::', prefixLength: 64 },
      distance: 1,
      nextHop: { kind: 'address', address: '2001:db8:12::2' },
    });
  });

  it('tells the sender when a router has no route', () => {
    const { lab, pc1 } = twoRouters();
    const { ping } = simulate(lab.topology);
    const events = ping(pc1, '2001:db8:99::1', 1);
    expect(events[0]).toMatchObject({ kind: 'unreachable', from: '2001:db8:1::1' });
  });

  it('times out when the far router has no way back', () => {
    const { lab, pc1 } = twoRouters({ r2Back: false });
    const { ping } = simulate(lab.topology);
    expect(ping(pc1, '2001:db8:2::10', 2).filter((e) => e.kind === 'timeout')).toHaveLength(2);
  });

  it('traces the route: each router answers Time Exceeded, then the target replies', () => {
    const { lab, pc1 } = twoRouters();
    const { trace } = simulate(lab.topology);
    const hops: string[][] = [];
    for (const event of trace(pc1, '2001:db8:2::10')) {
      if (event.kind === 'done') continue;
      (hops[event.hop - 1] ??= []).push(
        event.kind === 'timeout' ? '*' : `${event.kind} ${event.from}`,
      );
    }
    expect(hops).toEqual([
      Array(3).fill('ttl-expired 2001:db8:1::1'),
      Array(3).fill('ttl-expired 2001:db8:12::2'),
      Array(3).fill('reply 2001:db8:2::10'),
    ]);
  });

  it('does not forward without ipv6 unicast-routing', () => {
    const { lab, pc1, r1 } = twoRouters();
    lab.edit(r1, (device) =>
      device.kind === 'router'
        ? { ...device, config: { ...device.config, ipv6UnicastRouting: undefined } }
        : device,
    );
    const { ping } = simulate(lab.topology);
    expect(ping(pc1, '2001:db8:2::10', 1)[0]?.kind).toBe('timeout');
  });
});

describe('Interface addresses', () => {
  it('forms an eui-64 address and a link-local from the port MAC, and drops them when the port goes down', () => {
    const lab = labBuilder();
    const r1 = router6(lab, 'R1', { 'GigabitEthernet0/0': { eui64: ['2001:db8:5::/64'] } });
    const pc1 = pc6(lab, 'PC1', '2001:db8:5::10/64');
    lab.connect(pc1, 'FastEthernet0', r1, 'GigabitEthernet0/0');
    const { status } = simulate(lab.topology);
    const port = lab.device(r1).ports.find((p) => p.id === 'GigabitEthernet0/0')!;
    const mac = port.kind === 'serial' ? undefined : port.mac;
    const [iface] = status(r1).interfaces;
    expect(iface).toMatchObject({
      linkLocal: linkLocalOf(mac!),
      addresses: [{ address: eui64Address(v6('2001:db8:5::'), mac!), origin: 'eui64' }],
    });
  });

  it('turns up a router interface with ipv6 enable alone, with a link-local address and no routes', () => {
    const lab = labBuilder();
    const r1 = router6(lab, 'R1', { 'GigabitEthernet0/0': {} });
    lab.edit(r1, (device) => {
      if (device.kind !== 'router') return device;
      const port = 'GigabitEthernet0/0' as PortId;
      const interfaces = {
        ...device.config.interfaces,
        [port]: { shutdown: false, ipv6: { enabled: true as const, addresses: [] } },
      };
      return { ...device, config: { ...device.config, interfaces } };
    });
    const pc1 = pc6(lab, 'PC1');
    lab.connect(pc1, 'FastEthernet0', r1, 'GigabitEthernet0/0');
    const { status } = simulate(lab.topology);
    expect(status(r1).interfaces[0]?.addresses).toEqual([]);
    expect(status(r1).routes).toEqual([]);
  });
});
