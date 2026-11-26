import type { Device, Ipv4Address, Ipv4Cidr, Port } from '@/model';
import type { DhcpClient, Lease } from './dhcpClient';

type Host = Extract<Device, { kind: 'pc' | 'server' }>;

export const isHost = (device: Device): device is Host =>
  device.kind === 'pc' || device.kind === 'server';

/** A host's address belongs to its first Ethernet port. */
export const hostPort = (device: Host): Exclude<Port, { kind: 'serial' }> | undefined =>
  device.ports.find((port) => port.kind !== 'serial');

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

export function hostAddressing(device: Host, client: DhcpClient): HostAddressing {
  const { ipv4 } = device.config;
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
