// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PingEvent, TraceEvent } from '@/engine/api';
import { DeviceId, Ipv4Address } from '@/model';
import { createEditorStore } from '@/model/store';
import type { PingReply, TraceProbe } from './backend';
import { engineBackend } from './engineBackend';

const client = vi.hoisted(() => ({
  ping: vi.fn(),
  traceroute: vi.fn(),
  sim: { arpTable: vi.fn(), clearArp: vi.fn(), cancel: vi.fn() },
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

  it('clears the ARP cache in the worker', async () => {
    client.sim.clearArp.mockResolvedValue({ ok: true, value: 1 });
    await expect(backend.clearArp(PC, ip('192.168.1.11'))).resolves.toBe(1);
    expect(client.sim.clearArp).toHaveBeenCalledWith(PC, '192.168.1.11');
    client.sim.clearArp.mockResolvedValue({ ok: false, error: 'powered-off' });
    await expect(backend.clearArp(PC)).rejects.toThrow('ARP: the device is powered off.');
  });
});
