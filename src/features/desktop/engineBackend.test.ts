// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DnsLookup, FetchEvent, PingEvent, TraceEvent } from '@/engine/api';
import { DeviceId, Ipv4Address, Ipv6Address } from '@/model';
import { createEditorStore } from '@/model/store';
import type { PingReply, TraceProbe } from './backend';
import { engineBackend } from './engineBackend';

const client = vi.hoisted(() => ({
  ping: vi.fn(),
  traceroute: vi.fn(),
  dhcpRenew: vi.fn(),
  resolve: vi.fn(),
  browse: vi.fn(),
  onBatch: vi.fn(),
  sim: {
    arpTable: vi.fn(),
    clearArp: vi.fn(),
    cancel: vi.fn(),
    hostIp: vi.fn(),
    ipv6Status: vi.fn(),
    dhcpRelease: vi.fn(),
  },
}));
vi.mock('@/engine/client', () => ({ startEngine: async () => client }));

const ip = (text: string) => Ipv4Address.parse(text);
const PC = DeviceId.parse('dev_PC0');
const OPTIONS = { count: 2, timeoutMs: 4000 };
const HANDLE = 5;

/** A worker call that plays `events` to its listener, a tick apart, then starts nothing more. */
function plays(events: readonly (PingEvent | TraceEvent)[]) {
  return async (_d: unknown, _t: unknown, _o: unknown, listener: (event: unknown) => void) => {
    void (async () => {
      for (const event of events) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        listener(event);
      }
    })();
    return { ok: true, value: HANDLE };
  };
}

const reply = (seq: number): PingReply => ({
  kind: 'reply',
  seq,
  from: ip('192.168.1.11'),
  bytes: 32,
  timeMs: 4,
  ttl: 128,
});

beforeEach(() => {
  vi.clearAllMocks();
  client.sim.cancel.mockResolvedValue(undefined);
});

describe('the engine host backend', () => {
  const backend = engineBackend(createEditorStore());

  it('passes each reply on and resolves on the summary', async () => {
    const summary: PingEvent = {
      kind: 'summary',
      target: ip('192.168.1.11'),
      sent: 2,
      received: 2,
    };
    client.ping.mockImplementation(plays([reply(1), reply(2), summary]));
    const replies: PingReply[] = [];
    await backend.ping(
      PC,
      ip('192.168.1.11'),
      OPTIONS,
      (r) => replies.push(r),
      new AbortController().signal,
    );
    expect(replies).toEqual([reply(1), reply(2)]);
    expect(client.ping).toHaveBeenCalledWith(PC, '192.168.1.11', OPTIONS, expect.any(Function));
    expect(client.sim.cancel).not.toHaveBeenCalled();
  });

  it('cancels the ping in the engine when aborted, and resolves at once', async () => {
    client.ping.mockImplementation(plays([reply(1), reply(2)]));
    const controller = new AbortController();
    const replies: PingReply[] = [];
    const done = backend.ping(
      PC,
      ip('192.168.1.11'),
      OPTIONS,
      (r) => {
        replies.push(r);
        controller.abort();
      },
      controller.signal,
    );
    await expect(done).resolves.toBeUndefined();
    expect(client.sim.cancel).toHaveBeenCalledWith(HANDLE);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(replies).toEqual([reply(1)]);
  });

  it('says why a device cannot ping', async () => {
    client.ping.mockResolvedValue({ ok: false, error: 'powered-off' });
    await expect(
      backend.ping(PC, ip('192.168.1.11'), OPTIONS, () => {}, new AbortController().signal),
    ).rejects.toThrow('PING: transmit failed, the device is powered off.');
  });

  it('passes each traceroute probe on and resolves when it is done', async () => {
    const probe: TraceProbe = { kind: 'timeout', hop: 1, probe: 1 };
    client.traceroute.mockImplementation(plays([probe, { kind: 'done' }]));
    const probes: TraceProbe[] = [];
    const options = { maxHops: 1, probesPerHop: 1, timeoutMs: 4000 };
    await backend.traceroute(
      PC,
      ip('10.0.0.1'),
      options,
      (p) => probes.push(p),
      new AbortController().signal,
    );
    expect(probes).toEqual([probe]);
    expect(client.traceroute).toHaveBeenCalledWith(PC, '10.0.0.1', options, expect.any(Function));
  });

  it('pings an IPv6 address', async () => {
    const target = Ipv6Address.parse('2001:db8:1::2');
    client.ping.mockImplementation(plays([{ kind: 'summary', target, sent: 0, received: 0 }]));
    await backend.ping(PC, target, OPTIONS, () => {}, new AbortController().signal);
    expect(client.ping).toHaveBeenCalledWith(PC, '2001:db8:1::2', OPTIONS, expect.any(Function));
  });

  it('cancels a traceroute aborted before it started', async () => {
    client.traceroute.mockImplementation(plays([]));
    const controller = new AbortController();
    controller.abort();
    const options = { maxHops: 30, probesPerHop: 3, timeoutMs: 4000 };
    await backend.traceroute(PC, ip('10.0.0.1'), options, () => {}, controller.signal);
    expect(client.sim.cancel).toHaveBeenCalledWith(HANDLE);
  });

  it('reads the ARP table from the worker', async () => {
    client.sim.arpTable.mockResolvedValue({ ok: true, value: [] });
    await expect(backend.arpTable(PC)).resolves.toEqual([]);
    client.sim.arpTable.mockResolvedValue({ ok: false, error: 'unknown-device' });
    await expect(backend.arpTable(PC)).rejects.toThrow(
      'ARP: this device is not in the simulation yet.',
    );
  });

  it('reads the host’s IPv6 status from the worker, or says why it cannot', async () => {
    const status = { routing: false, interfaces: [], routes: [], neighbors: [], ports: {} };
    client.sim.ipv6Status.mockResolvedValue({ ok: true, value: status });
    await expect(backend.ipv6Status(PC)).resolves.toEqual(status);
    expect(client.sim.ipv6Status).toHaveBeenCalledWith(PC);
    client.sim.ipv6Status.mockResolvedValue({ ok: false, error: 'powered-off' });
    await expect(backend.ipv6Status(PC)).rejects.toThrow('IPV6CONFIG: the device is powered off.');
  });

  it('clears the ARP cache in the worker', async () => {
    client.sim.clearArp.mockResolvedValue({ ok: true, value: 1 });
    await expect(backend.clearArp(PC, ip('192.168.1.11'))).resolves.toBe(1);
    expect(client.sim.clearArp).toHaveBeenCalledWith(PC, '192.168.1.11');
    client.sim.clearArp.mockResolvedValue({ ok: false, error: 'powered-off' });
    await expect(backend.clearArp(PC)).rejects.toThrow('ARP: the device is powered off.');
  });
});

describe('the engine host backend and DHCP', () => {
  const backend = engineBackend(createEditorStore());

  it('reads the host’s addressing with the simulated clock of the latest batch', async () => {
    const addressing = { kind: 'unassigned' };
    client.sim.hostIp.mockResolvedValue({ ok: true, value: addressing });
    client.onBatch.mockImplementation((listener: (batch: { now: number }) => void) =>
      listener({ now: 4200 }),
    );
    expect(await engineBackend(createEditorStore()).hostIp(PC)).toEqual({ addressing, now: 4200 });
  });

  it('resolves a renewal with what the client heard', async () => {
    client.dhcpRenew.mockImplementation(
      async (_device: unknown, listener: (o: unknown) => void) => {
        setTimeout(() => listener({ kind: 'failed' }), 1);
        return { ok: true, value: undefined };
      },
    );
    expect(await backend.renewDhcp(PC)).toEqual({ kind: 'failed' });
  });

  it('says why a device cannot release', async () => {
    client.sim.dhcpRelease.mockResolvedValue({ ok: false, error: 'powered-off' });
    await expect(backend.releaseDhcp(PC)).rejects.toThrow('IPCONFIG: the device is powered off.');
  });
});

describe('the engine host backend, DNS and the web', () => {
  const backend = engineBackend(createEditorStore());
  const SERVER = ip('192.168.1.20');
  const TARGET = { host: 'www.lab.local', port: 80, path: '/' };

  it('resolves a lookup with what the resolver heard, or says why it could not ask', async () => {
    const answer: DnsLookup = {
      kind: 'answer',
      server: SERVER,
      name: 'www.lab.local',
      address: SERVER,
    };
    client.resolve.mockImplementation(
      async (_d: unknown, _n: unknown, _s: unknown, listener: (l: DnsLookup) => void) => {
        setTimeout(() => listener(answer), 1);
        return { ok: true, value: undefined };
      },
    );
    expect(await backend.nslookup(PC, 'www.lab.local', undefined)).toEqual(answer);
    expect(client.resolve).toHaveBeenCalledWith(
      PC,
      'www.lab.local',
      undefined,
      expect.any(Function),
    );
    client.resolve.mockResolvedValue({ ok: false, error: 'powered-off' });
    await expect(backend.nslookup(PC, 'www.lab.local', SERVER)).rejects.toThrow(
      "*** Can't look up www.lab.local: the device is powered off.",
    );
  });

  /** A browse that plays `events` to its listener, a tick apart. */
  const browsing = (events: readonly FetchEvent[]) =>
    client.browse.mockImplementation(
      async (_d: unknown, _t: unknown, listener: (event: FetchEvent) => void) => {
        void (async () => {
          for (const event of events) {
            await new Promise((resolve) => setTimeout(resolve, 1));
            listener(event);
          }
        })();
        return { ok: true, value: undefined };
      },
    );

  it('passes every step of a page load on and resolves after the last', async () => {
    const steps: FetchEvent[] = [
      { kind: 'resolving', name: 'www.lab.local', server: SERVER },
      { kind: 'connecting', address: SERVER, port: 80 },
      { kind: 'failed', failure: { kind: 'refused', address: SERVER, port: 80 } },
    ];
    browsing(steps);
    const heard: FetchEvent[] = [];
    await backend.browse(PC, TARGET, (event) => heard.push(event), new AbortController().signal);
    expect(heard).toEqual(steps);
    expect(client.browse).toHaveBeenCalledWith(PC, TARGET, expect.any(Function));
  });

  it('stops passing steps on once aborted, and resolves at once', async () => {
    browsing([
      { kind: 'resolving', name: 'www.lab.local', server: SERVER },
      { kind: 'connecting', address: SERVER, port: 80 },
    ]);
    const controller = new AbortController();
    const heard: FetchEvent[] = [];
    const done = backend.browse(
      PC,
      TARGET,
      (event) => {
        heard.push(event);
        controller.abort();
      },
      controller.signal,
    );
    await expect(done).resolves.toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(heard).toHaveLength(1);
  });

  it('says why a device cannot browse', async () => {
    client.browse.mockResolvedValue({ ok: false, error: 'unsupported' });
    await expect(
      backend.browse(PC, TARGET, () => {}, new AbortController().signal),
    ).rejects.toThrow('The page could not load: this device cannot do that.');
  });
});
