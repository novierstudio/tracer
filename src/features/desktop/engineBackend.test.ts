// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PingEvent, PingListener } from '@/engine/api';
import { DeviceId, Ipv4Address } from '@/model';
import { createEditorStore } from '@/model/store';
import type { PingReply } from './backend';
import { engineBackend } from './engineBackend';

const client = vi.hoisted(() => ({
  ping: vi.fn(),
  sim: { arpTable: vi.fn() },
}));
vi.mock('@/engine/client', () => ({ startEngine: async () => client }));

const ip = (text: string) => Ipv4Address.parse(text);
const PC = DeviceId.parse('dev_PC0');
const OPTIONS = { count: 2, timeoutMs: 4000 };

/** A worker ping that plays `events` to its listener, a tick apart. */
function plays(events: readonly PingEvent[]) {
  client.ping.mockImplementation(async (_d, _t, _o, listener: PingListener) => {
    void (async () => {
      for (const event of events) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        listener(event);
      }
    })();
    return { ok: true, value: undefined };
  });
}

const reply = (seq: number): PingReply => ({
  kind: 'reply',
  seq,
  from: ip('192.168.1.11'),
  bytes: 32,
  timeMs: 4,
  ttl: 128,
});

beforeEach(() => vi.clearAllMocks());

describe('the engine host backend', () => {
  const backend = engineBackend(createEditorStore());

  it('passes each reply on and resolves on the summary', async () => {
    const summary: PingEvent = {
      kind: 'summary',
      target: ip('192.168.1.11'),
      sent: 2,
      received: 2,
    };
    plays([reply(1), reply(2), summary]);
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
  });

  it('stops listening when aborted, though the engine keeps going', async () => {
    plays([reply(1)]);
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
    expect(replies).toEqual([reply(1)]);
  });

  it('says why a device cannot ping', async () => {
    client.ping.mockResolvedValue({ ok: false, error: 'powered-off' });
    await expect(
      backend.ping(PC, ip('192.168.1.11'), OPTIONS, () => {}, new AbortController().signal),
    ).rejects.toThrow('PING: transmit failed, the device is powered off.');
  });

  it('reads the ARP table from the worker', async () => {
    client.sim.arpTable.mockResolvedValue({ ok: true, value: [] });
    await expect(backend.arpTable(PC)).resolves.toEqual([]);
    client.sim.arpTable.mockResolvedValue({ ok: false, error: 'unknown-device' });
    await expect(backend.arpTable(PC)).rejects.toThrow(
      'ARP: this device is not in the simulation yet.',
    );
  });

  it('cannot clear the ARP cache yet', async () => {
    await expect(backend.clearArp(PC)).rejects.toThrow('cannot clear the ARP cache');
  });
});
