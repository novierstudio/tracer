// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HostAddressing, SimEventBatch } from '@/engine/api';
import { buildOffice } from '@/features/inspector/testing';
import type { DeviceId, Topology } from '@/model';
import { hostAddresses, trackHostAddresses } from './hostAddresses';

const leased = (address: string): HostAddressing =>
  ({
    kind: 'leased',
    address: { address, prefixLength: 24 },
    dns: [],
    server: '192.168.1.1',
    via: '02:00:00:00:00:01',
    obtainedAt: 0,
  }) as unknown as HostAddressing;

/** The office lab with PC1 on DHCP, a client whose PC1 holds `answer`, and a way to send batches. */
function setup(answer: () => HostAddressing) {
  const { topology, pc } = buildOffice();
  const host = topology.devices[pc.id]!;
  const dhcpTopology: Topology = {
    ...topology,
    devices: {
      ...topology.devices,
      [pc.id]: { ...host, config: { ...host.config, ipv4: { mode: 'dhcp' } } } as typeof host,
    },
  };
  let batch: ((batch: SimEventBatch) => void) | undefined;
  const hostIp = vi.fn(async () => ({ ok: true as const, value: answer() }));
  const client = {
    sim: { hostIp },
    onBatch: (listener: (batch: SimEventBatch) => void) => {
      batch = listener;
      return () => {};
    },
  } as unknown as Parameters<typeof trackHostAddresses>[0];
  const source = { getState: () => ({ topology: dhcpTopology }), subscribe: () => () => {} };
  const stop = trackHostAddresses(client, source);
  const send = (events: number) =>
    batch!({ events: Array.from({ length: events }) } as unknown as SimEventBatch);
  return { pc: pc.id as DeviceId, hostIp, send, stop };
}

afterEach(() => hostAddresses.setState({}, true));

describe('trackHostAddresses', () => {
  it('asks for each DHCP host’s addressing, again after a batch that logged something', async () => {
    let current = leased('192.168.1.11');
    const { pc, hostIp, send, stop } = setup(() => current);
    await vi.waitFor(() => expect(hostAddresses.getState()[pc]).toEqual(current));
    expect(hostIp).toHaveBeenCalledTimes(1);

    send(0);
    expect(hostIp).toHaveBeenCalledTimes(1);

    current = leased('192.168.1.12');
    send(3);
    await vi.waitFor(() => expect(hostAddresses.getState()[pc]).toEqual(current));
    stop();
  });

  it('keeps the object of an addressing that did not change', async () => {
    const { pc, hostIp, send, stop } = setup(() => leased('192.168.1.11'));
    await vi.waitFor(() => expect(hostAddresses.getState()[pc]).toBeDefined());
    const first = hostAddresses.getState()[pc];
    send(1);
    await vi.waitFor(() => expect(hostIp).toHaveBeenCalledTimes(2));
    await Promise.resolve();
    expect(hostAddresses.getState()[pc]).toBe(first);
    stop();
  });
});
