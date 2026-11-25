// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { buildOffice } from '@/features/inspector/testing';
import { createIdSource, Ipv4Address, PrefixLength } from '@/model';
import { createEditorStore } from '@/model/store';
import type { PingReply } from './backend';
import { createMockBackend } from './mockBackend';

const ip = (text: string) => Ipv4Address.parse(text);

function office() {
  const lab = buildOffice();
  const store = createEditorStore({ topology: lab.topology, ids: createIdSource(3) });
  const backend = createMockBackend(store, { intervalMs: 0 });
  const ping = async (target: string, count = 2) => {
    const replies: PingReply[] = [];
    const options = { count, timeoutMs: 1000 };
    await backend.ping(
      lab.pc.id,
      ip(target),
      options,
      (r) => replies.push(r),
      new AbortController().signal,
    );
    return replies;
  };
  return { ...lab, store, backend, ping };
}

describe('the mock host backend', () => {
  it('gets replies from a router on the same subnet through the switch', async () => {
    const { ping } = office();
    expect(await ping('192.168.1.1')).toEqual([
      { kind: 'reply', from: '192.168.1.1', bytes: 32, timeMs: 1, ttl: 255 },
      { kind: 'reply', from: '192.168.1.1', bytes: 32, timeMs: 0, ttl: 255 },
    ]);
  });

  it('gets replies from another host once it has an address', async () => {
    const { ping, store, server } = office();
    if (server.kind !== 'server') throw new Error('Server1 is not a server');
    const address = { address: ip('192.168.1.20'), prefixLength: PrefixLength.parse(24) };
    store.getState().updateConfig({
      device: server.id,
      kind: 'server',
      config: { ...server.config, ipv4: { mode: 'static', address } },
    });
    expect((await ping('192.168.1.20', 1))[0]).toMatchObject({ kind: 'reply', ttl: 128 });
  });

  it('reports an address on the subnet that nothing answers as unreachable', async () => {
    const { ping } = office();
    expect(await ping('192.168.1.99', 1)).toEqual([{ kind: 'unreachable', from: '192.168.1.10' }]);
  });

  it('stops answering when the cable comes out', async () => {
    const { ping, store, pcLink } = office();
    store.getState().removeLinks([pcLink.id]);
    expect(await ping('192.168.1.1', 1)).toEqual([{ kind: 'unreachable', from: '192.168.1.10' }]);
  });

  it('times out off the subnet, since it does not route', async () => {
    const { ping } = office();
    expect(await ping('8.8.8.8', 1)).toEqual([{ kind: 'timeout' }]);
  });

  it('learns the MAC of a host it reached, until arp -d', async () => {
    const { ping, backend, pc, r1 } = office();
    await ping('192.168.1.1', 1);
    const mac = r1.ports[0]?.kind === 'serial' ? undefined : r1.ports[0]?.mac;
    expect(await backend.arpTable(pc.id)).toEqual([
      { address: '192.168.1.1', mac, type: 'dynamic' },
    ]);
    await backend.clearArp(pc.id);
    expect(await backend.arpTable(pc.id)).toEqual([]);
  });

  it('sends nothing more once aborted', async () => {
    const { backend, pc } = office();
    const controller = new AbortController();
    const replies: PingReply[] = [];
    await backend.ping(
      pc.id,
      ip('192.168.1.1'),
      { count: Infinity, timeoutMs: 1000 },
      (r) => {
        replies.push(r);
        if (replies.length === 3) controller.abort();
      },
      controller.signal,
    );
    expect(replies).toHaveLength(3);
  });
});
