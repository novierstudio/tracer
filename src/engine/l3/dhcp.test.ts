import { describe, expect, it } from 'vitest';
import {
  DhcpServerConfig,
  PortId,
  SubinterfaceId,
  type Device,
  type DeviceId,
  type Subinterface,
  type Topology,
} from '@/model';
import type { DhcpOutcome, HostAddressing, PingEvent } from '../api';
import { after, ms } from '../core/time';
import { createEngine, type Engine } from '../engine';
import type { FrameEvent } from '../events';
import { createSimService } from '../service';
import { STACKS } from '../stacks';
import { access, cidr, ip, labBuilder, STP_CONVERGED_IOS, trunk } from '../testing';
import type { DhcpMessage } from '../pdu';

const LAN_POOL = {
  pools: {
    LAN: {
      network: { address: '192.168.1.0', prefixLength: 24 },
      defaultRouters: ['192.168.1.1'],
      dnsServers: ['8.8.8.8'],
    },
  },
  excluded: [{ first: '192.168.1.1', last: '192.168.1.10' }],
};

/** Gives a router a DHCP server config, parsed as a file would be. */
const withDhcp =
  (dhcp: unknown) =>
  (device: Device): Device =>
    device.kind === 'router'
      ? { ...device, config: { ...device.config, dhcp: DhcpServerConfig.parse(dhcp) } }
      : device;

/** R1 serving 192.168.1.0/24 on Gi0/0 to `hosts` DHCP PCs, each cabled straight to SW1. */
function switchedLab({ hosts = 1, dhcp = LAN_POOL as unknown } = {}) {
  const lab = labBuilder();
  const r1 = lab.router('R1', { 'GigabitEthernet0/0': '192.168.1.1/24' });
  lab.edit(r1, withDhcp(dhcp));
  const sw1 = lab.switch('SW1');
  lab.connect(sw1, 'GigabitEthernet0/1', r1, 'GigabitEthernet0/0');
  const pcs = Array.from({ length: hosts }, (_, n) => {
    const pc = lab.dhcpHost('pc', `PC${n + 1}`);
    lab.connect(pc, 'FastEthernet0', sw1, `FastEthernet0/${n + 1}`);
    return pc;
  });
  return { lab, r1, sw1, pcs };
}

/** R1 serving its pool to PC1, cabled straight to Gi0/0, so no spanning tree delays it. */
function directLab(dhcp: unknown = LAN_POOL) {
  const lab = labBuilder();
  const r1 = lab.router('R1', { 'GigabitEthernet0/0': '192.168.1.1/24' });
  lab.edit(r1, withDhcp(dhcp));
  const pc1 = lab.dhcpHost('pc', 'PC1');
  lab.connect(pc1, 'FastEthernet0', r1, 'GigabitEthernet0/0');
  return { lab, r1, pc1 };
}

function simulate(topology: Topology, seed = 1) {
  const engine = createEngine({ seed, stacks: STACKS, linkDelay: ms(1) });
  const sim = createSimService({ engine, frames: { now: () => 0, request: () => {} } });
  sim.load(topology);
  const value = <T>(result: { ok: true; value: T } | { ok: false; error: string }): T => {
    if (!result.ok) throw new Error(result.error);
    return result.value;
  };
  const hostIp = (device: DeviceId): HostAddressing => value(sim.hostIp(device));
  const address = (device: DeviceId) => {
    const host = hostIp(device);
    return host.kind === 'unassigned' ? undefined : host.address?.address;
  };
  const runFor = (millis: number) => engine.runUntil(after(engine.now, ms(millis)));
  /** Runs until `done` holds, a step at a time, or fails after `limit` of simulated time. */
  const runUntil = (done: () => boolean, limit = 10 * 60_000) => {
    const end = engine.now + limit;
    while (!done()) {
      const next = engine.nextTime();
      if (next === undefined || next > end) throw new Error('ran out of time');
      engine.step();
    }
  };
  const leased = (device: DeviceId) => () => hostIp(device).kind === 'leased';
  const ping = (from: DeviceId, target: string) => {
    const events: PingEvent[] = [];
    value(sim.ping(from, ip(target), { count: 4, timeoutMs: 1000 }, (event) => events.push(event)));
    runUntil(() => events.some((event) => event.kind === 'summary'));
    return events.find((event) => event.kind === 'summary');
  };
  return { engine, sim, value, hostIp, address, runFor, runUntil, leased, ping };
}

const dhcpOf = ({ frame }: FrameEvent): DhcpMessage | undefined => {
  const packet =
    frame.kind === 'ethernet' && frame.payload.kind === 'ipv4' ? frame.payload : undefined;
  return packet?.payload.kind === 'udp' ? packet.payload.payload : undefined;
};

/** The DHCP messages `device` sent, in order, with when they left. */
function sentBy(engine: Engine, device: DeviceId) {
  return engine.log
    .since(0 as never)
    .flatMap((event) =>
      event.kind === 'frame' && event.from.device === device && dhcpOf(event)
        ? [{ type: dhcpOf(event)!.type, at: event.sentAt, message: dhcpOf(event)! }]
        : [],
    );
}

describe('DHCP', () => {
  it('leases a PC the lowest address past the excluded range, with the pool’s options', () => {
    const { lab, r1, pc1 } = directLab();
    const { hostIp, runUntil, leased, value, sim, engine } = simulate(lab.topology);

    runUntil(leased(pc1));

    expect(hostIp(pc1)).toEqual({
      kind: 'leased',
      address: cidr('192.168.1.11/24'),
      gateway: ip('192.168.1.1'),
      dns: [ip('8.8.8.8')],
      server: ip('192.168.1.1'),
      via: expect.any(String),
      obtainedAt: expect.any(Number),
      expiresAt: expect.any(Number),
    });
    const host = hostIp(pc1);
    if (host.kind !== 'leased') throw new Error('not leased');
    expect(host.expiresAt! - host.obtainedAt).toBe(24 * 60 * 60_000);
    expect(sentBy(engine, pc1).map((sent) => sent.type)).toEqual(['discover', 'request']);
    expect(sentBy(engine, r1).map((sent) => sent.type)).toEqual(['offer', 'ack']);
    const port = lab.device(pc1).ports[0]!;
    // The server starts the lease as it sends the Ack, a link delay before the PC has it.
    expect(value(sim.dhcpBindings(r1))).toEqual([
      {
        address: '192.168.1.11',
        mac: port.kind === 'serial' ? undefined : port.mac,
        pool: 'LAN',
        expiresAt: host.expiresAt! - 1,
      },
    ]);
  });

  it('gives two PCs different addresses', () => {
    const { lab, pcs } = switchedLab({ hosts: 2 });
    const { address, runUntil, leased } = simulate(lab.topology);
    const [pc1, pc2] = pcs as [DeviceId, DeviceId];

    runUntil(() => leased(pc1)() && leased(pc2)());

    expect(new Set([address(pc1), address(pc2)])).toEqual(
      new Set(['192.168.1.11', '192.168.1.12']),
    );
  });

  it('waits out spanning tree behind a switch, then gets its lease', () => {
    const { lab, pcs } = switchedLab();
    const topology: Topology = { ...lab.topology, settings: { stpTimers: 'ios' } };
    const { hostIp, runUntil, leased, engine } = simulate(topology);
    const [pc1] = pcs as [DeviceId];

    runUntil(leased(pc1));

    const host = hostIp(pc1);
    expect(host.kind === 'leased' && host.obtainedAt).toBeGreaterThan(STP_CONVERGED_IOS);
    // The switch held the port, so the first Discovers went unanswered.
    const discovers = sentBy(engine, pc1).filter((sent) => sent.type === 'discover');
    expect(discovers.length).toBeGreaterThan(1);
    expect(discovers[0]!.at).toBe(0);
  });

  it('pings its gateway once it has a lease', () => {
    const { lab, pcs } = switchedLab();
    const { runUntil, leased, ping } = simulate(lab.topology);
    const [pc1] = pcs as [DeviceId];

    runUntil(leased(pc1));

    expect(ping(pc1, '192.168.1.1')).toMatchObject({ sent: 4, received: 4 });
  });

  it('renews with its server halfway through the lease and keeps the address', () => {
    const { lab, r1, pc1 } = directLab({
      ...LAN_POOL,
      pools: { LAN: { ...LAN_POOL.pools.LAN, lease: 1 } },
    });
    const { hostIp, runUntil, leased, runFor, engine } = simulate(lab.topology);
    runUntil(leased(pc1));
    const first = hostIp(pc1);
    if (first.kind !== 'leased') throw new Error('not leased');
    expect(first.expiresAt! - first.obtainedAt).toBe(60_000);

    runFor(31_000);

    const renewed = hostIp(pc1);
    expect(renewed).toMatchObject({ kind: 'leased', address: first.address });
    if (renewed.kind !== 'leased') throw new Error('not leased');
    expect(renewed.obtainedAt).toBeGreaterThanOrEqual(first.obtainedAt + 30_000);
    // The renewal goes straight to the server from the leased address, once ARP finds it.
    const request = sentBy(engine, pc1).at(-1)!;
    expect(request.type).toBe('request');
    expect(request.at - (first.obtainedAt + 30_000)).toBeLessThan(10);
    expect(request.message).toMatchObject({ ciaddr: '192.168.1.11', broadcast: false });
    expect(sentBy(engine, r1).at(-1)!.type).toBe('ack');
  });

  it('renews on request, keeping the address, and says when it got the lease', () => {
    const { lab, pc1 } = directLab();
    const { address, runUntil, leased, sim, value } = simulate(lab.topology);
    runUntil(leased(pc1));

    const outcomes: DhcpOutcome[] = [];
    value(sim.dhcpRenew(pc1, (outcome) => outcomes.push(outcome)));
    runUntil(() => outcomes.length > 0);

    expect(outcomes).toEqual([
      { kind: 'bound', lease: expect.objectContaining({ server: '192.168.1.1' }) },
    ]);
    expect(address(pc1)).toBe('192.168.1.11');
  });

  it('frees the address on release, and hands it out again', () => {
    const { lab, r1, pcs } = switchedLab({ hosts: 2 });
    const [pc1, pc2] = pcs as [DeviceId, DeviceId];
    const topology = withHostOff(lab.topology, pc2);
    const { hostIp, address, runUntil, leased, runFor, sim, value, engine } = simulate(topology);
    runUntil(leased(pc1));
    expect(address(pc1)).toBe('192.168.1.11');

    value(sim.dhcpRelease(pc1));
    runFor(100);

    expect(hostIp(pc1)).toEqual({ kind: 'unassigned' });
    expect(sentBy(engine, pc1).at(-1)!.type).toBe('release');
    expect(value(sim.dhcpBindings(r1))).toEqual([]);
    // A released host asks for nothing until told to.
    runFor(5 * 60_000);
    expect(hostIp(pc1)).toEqual({ kind: 'unassigned' });

    sim.applyPatch({ devices: { [pc2]: { ...topology.devices[pc2]!, powered: true } }, links: {} });
    runUntil(leased(pc2));
    expect(address(pc2)).toBe('192.168.1.11');
  });

  it('gives itself a link-local address when the pool has nothing left, and asks again later', () => {
    const tiny = {
      pools: { LAN: { network: { address: '192.168.1.0', prefixLength: 29 } } },
      excluded: [{ first: '192.168.1.1', last: '192.168.1.5' }],
    };
    const { lab, r1, pcs } = switchedLab({ hosts: 2, dhcp: tiny });
    const [pc1, pc2] = pcs as [DeviceId, DeviceId];
    const { hostIp, address, runUntil, leased, engine, value, sim } = simulate(lab.topology);

    runUntil(() => leased(pc1)() || leased(pc2)());
    const [winner, loser] = leased(pc1)() ? [pc1, pc2] : [pc2, pc1];
    expect(address(winner)).toBe('192.168.1.6');
    runUntil(() => hostIp(loser).kind === 'autoconfigured');

    const fallback = address(loser)!;
    expect(fallback).toMatch(/^169\.254\.(\d+)\.(\d+)$/);
    expect(hostIp(loser)).toMatchObject({ address: { prefixLength: 16 } });
    expect(sentBy(engine, loser).filter((sent) => sent.type === 'discover')).toHaveLength(5);
    expect(engine.log.since(0 as never)).toContainEqual(
      expect.objectContaining({
        kind: 'note',
        device: r1,
        text: expect.stringMatching(/no free address/),
      }),
    );

    // Once the winner lets its address go, the next try gets it.
    value(sim.dhcpRelease(winner));
    runUntil(leased(loser));
    expect(address(loser)).toBe('192.168.1.6');
  });

  it('stays silent for a network it has no pool for', () => {
    const { lab, r1, pc1 } = directLab({
      pools: { OTHER: { network: { address: '10.0.0.0', prefixLength: 8 } } },
      excluded: [],
    });
    const { hostIp, runFor, engine } = simulate(lab.topology);
    runFor(70_000);
    expect(hostIp(pc1).kind).toBe('autoconfigured');
    expect(sentBy(engine, r1)).toEqual([]);
  });

  it('drops the lease when the cable comes out, and gets it back when it goes in', () => {
    const { lab, pc1 } = directLab();
    const { address, runUntil, leased, sim, hostIp } = simulate(lab.topology);
    runUntil(leased(pc1));
    const [link] = Object.values(lab.topology.links);

    sim.applyPatch({ devices: {}, links: { [link!.id]: null } });
    expect(hostIp(pc1)).toEqual({ kind: 'unassigned' });

    sim.applyPatch({ devices: {}, links: { [link!.id]: link! } });
    runUntil(leased(pc1));
    expect(address(pc1)).toBe('192.168.1.11');
  });

  it('starts asking when a static host switches to DHCP, and stops when it switches back', () => {
    const lab = labBuilder();
    const r1 = lab.router('R1', { 'GigabitEthernet0/0': '192.168.1.1/24' });
    lab.edit(r1, withDhcp(LAN_POOL));
    const pc1 = lab.host('pc', 'PC1', '192.168.1.50/24', '192.168.1.1');
    lab.connect(pc1, 'FastEthernet0', r1, 'GigabitEthernet0/0');
    const { hostIp, address, runFor, runUntil, leased, sim } = simulate(lab.topology);
    runFor(1000);
    expect(address(pc1)).toBe('192.168.1.50');

    const pc = lab.topology.devices[pc1]!;
    const asDhcp = { ...pc, config: { ...pc.config, ipv4: { mode: 'dhcp' } } } as Device;
    sim.applyPatch({ devices: { [pc1]: asDhcp }, links: {} });
    runUntil(leased(pc1));
    expect(address(pc1)).toBe('192.168.1.11');

    sim.applyPatch({ devices: { [pc1]: pc }, links: {} });
    expect(hostIp(pc1)).toMatchObject({ kind: 'static', address: cidr('192.168.1.50/24') });
  });

  it('runs the same way every time with the same seed', () => {
    const { lab } = switchedLab({ hosts: 2 });
    const run = () => {
      const { engine, runFor } = simulate(lab.topology, 7);
      runFor(20_000);
      return JSON.stringify(engine.log.since(0 as never));
    };
    expect(run()).toBe(run());
  });

  it('steps back through a DORA in Simulation mode and replays it the same', () => {
    const { lab, pc1 } = directLab();
    const { sim, hostIp, engine } = simulate(lab.topology);
    sim.setMode('simulation');

    const forward: string[] = [];
    while (hostIp(pc1).kind !== 'leased') {
      forward.push(...sim.step().map((event) => JSON.stringify(event)));
      if (engine.now > 10_000) throw new Error('no lease');
    }
    const steps = forward.length;
    expect(steps).toBeGreaterThan(0);

    // Back to before the Discover, then forward again to the same lease, event for event.
    while (sim.stepBack());
    expect(hostIp(pc1)).toEqual({ kind: 'unassigned' });
    const replayed: string[] = [];
    while (hostIp(pc1).kind !== 'leased')
      replayed.push(...sim.step().map((event) => JSON.stringify(event)));
    expect(replayed).toEqual(forward);
  });
});

describe('DHCP relay', () => {
  /** PC1 on R1's Gi0/0, which relays to R2 across 10.0.0.0/30; R2 holds the pool. */
  function relayLab() {
    const lab = labBuilder();
    const r1 = lab.router('R1', {
      'GigabitEthernet0/0': '192.168.1.1/24',
      'GigabitEthernet0/1': '10.0.0.1/30',
    });
    lab.edit(r1, (device) => {
      if (device.kind !== 'router') return device;
      const g00 = device.config.interfaces['GigabitEthernet0/0' as never]!;
      const interfaces = {
        ...device.config.interfaces,
        'GigabitEthernet0/0': { ...g00, helperAddresses: [ip('10.0.0.2')] },
      };
      return { ...device, config: { ...device.config, interfaces } };
    });
    const r2 = lab.router('R2', { 'GigabitEthernet0/0': '10.0.0.2/30' }, [
      { prefix: cidr('192.168.1.0/24'), nextHop: { kind: 'address', address: ip('10.0.0.1') } },
    ]);
    lab.edit(r2, withDhcp(LAN_POOL));
    const pc1 = lab.dhcpHost('pc', 'PC1');
    lab.connect(pc1, 'FastEthernet0', r1, 'GigabitEthernet0/0');
    lab.connect(r1, 'GigabitEthernet0/1', r2, 'GigabitEthernet0/0');
    return { lab, r1, r2, pc1 };
  }

  it('leases an address from a server on another network through the helper address', () => {
    const { lab, r1, r2, pc1 } = relayLab();
    const { hostIp, runUntil, leased, ping, engine, sim, value } = simulate(lab.topology);

    runUntil(leased(pc1));

    expect(hostIp(pc1)).toMatchObject({
      address: cidr('192.168.1.11/24'),
      gateway: ip('192.168.1.1'),
      server: ip('10.0.0.2'),
    });
    const relayed = sentBy(engine, r1).find((sent) => sent.type === 'discover')!;
    expect(relayed.message).toMatchObject({ giaddr: '192.168.1.1', hops: 1 });
    expect(value(sim.dhcpBindings(r2))).toHaveLength(1);
    expect(ping(pc1, '10.0.0.2')).toMatchObject({ received: 4 });
  });

  it('renews with the far server straight through the gateway', () => {
    const { lab, pc1 } = relayLab();
    const { hostIp, runUntil, leased, sim, value } = simulate(lab.topology);
    runUntil(leased(pc1));
    const outcomes: DhcpOutcome[] = [];
    value(sim.dhcpRenew(pc1, (outcome) => outcomes.push(outcome)));
    runUntil(() => outcomes.length > 0);
    expect(outcomes[0]!.kind).toBe('bound');
    expect(hostIp(pc1)).toMatchObject({ address: cidr('192.168.1.11/24') });
  });

  it('serves hosts on two VLANs from one router, each from its own pool', () => {
    const lab = labBuilder();
    const r1 = lab.router('R1', {});
    lab.edit(r1, (device) => {
      if (device.kind !== 'router') return device;
      const sub = (vlan: number, address: string): Subinterface => ({
        shutdown: false,
        encapsulation: { vlan: vlan as never, native: false },
        ipv4: cidr(address),
      });
      return withDhcp({
        pools: {
          SALES: {
            network: { address: '192.168.10.0', prefixLength: 24 },
            defaultRouters: ['192.168.10.1'],
          },
          STAFF: {
            network: { address: '192.168.20.0', prefixLength: 24 },
            defaultRouters: ['192.168.20.1'],
          },
        },
        excluded: [],
      })({
        ...device,
        config: {
          ...device.config,
          interfaces: {
            ...device.config.interfaces,
            [PortId.parse('GigabitEthernet0/0')]: { shutdown: false },
          },
          subinterfaces: {
            [SubinterfaceId.parse('GigabitEthernet0/0.10')]: sub(10, '192.168.10.1/24'),
            [SubinterfaceId.parse('GigabitEthernet0/0.20')]: sub(20, '192.168.20.1/24'),
          },
        },
      });
    });
    const sw1 = lab.switch('SW1', {
      'FastEthernet0/1': access(10),
      'FastEthernet0/2': access(20),
      'GigabitEthernet0/1': trunk(),
    });
    const pc1 = lab.dhcpHost('pc', 'PC1');
    const pc2 = lab.dhcpHost('pc', 'PC2');
    lab.connect(pc1, 'FastEthernet0', sw1, 'FastEthernet0/1');
    lab.connect(pc2, 'FastEthernet0', sw1, 'FastEthernet0/2');
    lab.connect(sw1, 'GigabitEthernet0/1', r1, 'GigabitEthernet0/0');
    const { hostIp, runUntil, leased } = simulate(lab.topology);

    runUntil(() => leased(pc1)() && leased(pc2)());

    expect(hostIp(pc1)).toMatchObject({
      address: cidr('192.168.10.2/24'),
      gateway: '192.168.10.1',
    });
    expect(hostIp(pc2)).toMatchObject({
      address: cidr('192.168.20.2/24'),
      gateway: '192.168.20.1',
    });
  });
});

/** The topology with `device` powered off. */
function withHostOff(topology: Topology, device: DeviceId): Topology {
  const host = topology.devices[device]!;
  return { ...topology, devices: { ...topology.devices, [device]: { ...host, powered: false } } };
}
