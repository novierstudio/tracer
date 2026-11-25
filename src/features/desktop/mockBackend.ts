import { inSubnet } from '@/features/inspector/ipv4';
import {
  linkAt,
  type DeviceId,
  type Endpoint,
  type Ipv4Address,
  type MacAddress,
  type Topology,
} from '@/model';
import type { HostBackend, PingReply } from './backend';
import { addressPort, isHostDevice } from './format';

type TopologySource = { getState(): { topology: Topology } };

type Owner = { end: Endpoint; mac: MacAddress; ttl: number };

/** The powered device port that holds `address`, with the TTL its replies start from. */
function ownerOf(topology: Topology, address: Ipv4Address): Owner | undefined {
  for (const device of Object.values(topology.devices)) {
    if (!device.powered) continue;
    if (isHostDevice(device)) {
      const port = addressPort(device);
      const { ipv4 } = device.config;
      if (port && ipv4.mode === 'static' && ipv4.address?.address === address) {
        return { end: { device: device.id, port: port.id }, mac: port.mac, ttl: 128 };
      }
    } else if (device.kind === 'router') {
      for (const port of device.ports) {
        const config = device.config.interfaces[port.id];
        if (port.kind !== 'serial' && !config?.shutdown && config?.ipv4?.address === address) {
          return { end: { device: device.id, port: port.id }, mac: port.mac, ttl: 255 };
        }
      }
    }
  }
  return undefined;
}

/** Whether a frame from `from` reaches `to` over cables and powered switches, VLANs aside. */
function bridged(topology: Topology, from: Endpoint, to: Endpoint): boolean {
  const seen = new Set<string>();
  const queue = [from];
  for (let end = queue.shift(); end; end = queue.shift()) {
    const link = linkAt(topology, end);
    if (!link) continue;
    const far = link.a.device === end.device && link.a.port === end.port ? link.b : link.a;
    if (far.device === to.device && far.port === to.port) return true;
    const device = topology.devices[far.device];
    if (device?.kind !== 'switch' || !device.powered || seen.has(device.id)) continue;
    if (device.config.interfaces[far.port]?.shutdown) continue;
    seen.add(device.id);
    for (const port of device.ports) {
      if (port.id !== far.port && !device.config.interfaces[port.id]?.shutdown) {
        queue.push({ device: device.id, port: port.id });
      }
    }
  }
  return false;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * A stand-in for the engine, answering from the topology alone: a target on the same subnet
 * behind cables and switches replies, one on the subnet that no frame reaches is unreachable, and
 * one off the subnet times out, because the mock does not route.
 */
export function createMockBackend(source: TopologySource, { intervalMs = 250 } = {}): HostBackend {
  const arp = new Map<DeviceId, Map<Ipv4Address, MacAddress>>();

  const probe = (device: DeviceId, target: Ipv4Address, first: boolean): PingReply => {
    const { topology } = source.getState();
    const host = topology.devices[device];
    if (!isHostDevice(host) || host.config.ipv4.mode !== 'static') return { kind: 'timeout' };
    const own = host.config.ipv4.address;
    const port = addressPort(host);
    if (!own || !port) return { kind: 'timeout' };
    if (target === own.address)
      return { kind: 'reply', from: target, bytes: 32, timeMs: 0, ttl: 128 };
    if (!inSubnet(own, target)) return { kind: 'timeout' };
    const owner = ownerOf(topology, target);
    if (!owner || !bridged(topology, { device, port: port.id }, owner.end)) {
      return { kind: 'unreachable', from: own.address };
    }
    const table = arp.get(device) ?? new Map<Ipv4Address, MacAddress>();
    arp.set(device, table.set(target, owner.mac));
    return { kind: 'reply', from: target, bytes: 32, timeMs: first ? 1 : 0, ttl: owner.ttl };
  };

  return {
    async ping(device, target, { count }, onReply, signal) {
      for (let sent = 0; sent < count; sent++) {
        await sleep(intervalMs, signal);
        if (signal.aborted) return;
        onReply(probe(device, target, sent === 0));
      }
    },
    async arpTable(device) {
      const table = arp.get(device) ?? new Map<Ipv4Address, MacAddress>();
      return [...table].map(([address, mac]) => ({ address, mac, type: 'dynamic' as const }));
    },
    async clearArp(device) {
      arp.delete(device);
    },
  };
}
