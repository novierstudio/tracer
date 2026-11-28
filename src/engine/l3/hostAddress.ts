import type { Device, HostIpv4, Ipv4Address, Ipv4Cidr, Port } from '@/model';
import { WAN_PORT } from '@/model/cabling';
import type { DhcpClient, Lease } from './dhcpClient';

type Host = Extract<Device, { kind: 'pc' | 'server' }>;

export const isHost = (device: Device): device is Host =>
  device.kind === 'pc' || device.kind === 'server';

type EthernetPort = Exclude<Port, { kind: 'serial' }>;

/** A host's address belongs to its first Ethernet port, or to its wireless NIC. */
export const hostPort = (device: Host): EthernetPort | undefined =>
  device.ports.find((port): port is EthernetPort => port.kind !== 'serial');

/**
 * The port a device addresses as a host does, statically or by DHCP, with the settings for it:
 * a host's NIC, or a home router's Internet port, which takes its address from the ISP.
 */
export function addressedPort(device: Device): { port: EthernetPort; ipv4: HostIpv4 } | undefined {
  if (isHost(device)) {
    const port = hostPort(device);
    return port && { port, ipv4: device.config.ipv4 };
  }
  if (device.kind !== 'wirelessRouter') return undefined;
  const port = device.ports.find((candidate) => candidate.id === WAN_PORT);
  return port && port.kind !== 'serial' ? { port, ipv4: device.config.wan } : undefined;
}

/**
 * A host's IPv4 settings as the simulation runs them. A static host has what its config says;
 * a DHCP host has what its client holds, which the config never stores: a lease, an address it
 * gave itself when no server answered, or nothing yet.
 */
export type HostAddressing =
  | {
      readonly kind: 'static';
      readonly address?: Ipv4Cidr;
      readonly gateway?: Ipv4Address;
      readonly dns: readonly Ipv4Address[];
    }
  | ({ readonly kind: 'leased' } & Lease)
  /** A link-local 169.254.x.y address, as Windows picks when no DHCP server answers. */
  | { readonly kind: 'autoconfigured'; readonly address: Ipv4Cidr }
  | { readonly kind: 'unassigned' };

export function hostAddressing(ipv4: HostIpv4, client: DhcpClient): HostAddressing {
  if (ipv4.mode === 'static') {
    const { address, gateway, dns } = ipv4;
    return { kind: 'static', address, gateway, dns: dns ? [dns] : [] };
  }
  switch (client.kind) {
    case 'bound':
    case 'renewing':
    case 'rebinding':
      return { kind: 'leased', ...client.lease };
    case 'autoconfigured':
      return { kind: 'autoconfigured', address: client.address };
    case 'selecting':
    case 'requesting':
      // While it asks again, a host keeps the address it gave itself.
      return client.fallback
        ? { kind: 'autoconfigured', address: client.fallback }
        : { kind: 'unassigned' };
    case 'stopped':
    case 'released':
      return { kind: 'unassigned' };
  }
}

export const addressOf = (host: HostAddressing): Ipv4Cidr | undefined =>
  host.kind === 'unassigned' ? undefined : host.address;

export const gatewayOf = (host: HostAddressing): Ipv4Address | undefined =>
  host.kind === 'static' || host.kind === 'leased' ? host.gateway : undefined;
