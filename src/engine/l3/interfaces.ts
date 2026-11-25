import type { Device, InterfaceId, Ipv4Address, Ipv4Cidr, MacAddress, PortId } from '@/model';

/** What carries an interface's packets: Ethernet needs ARP, a serial link has one peer. */
export type Medium =
  | { readonly kind: 'ethernet'; readonly port: PortId; readonly mac: MacAddress }
  | { readonly kind: 'serial'; readonly port: PortId }
  | { readonly kind: 'loopback' };

/** An interface that is up and has an address, so it can send, receive and own routes. */
export type IpInterface = {
  readonly name: InterfaceId;
  /** The interface's own address, with the prefix length of its subnet. */
  readonly cidr: Ipv4Cidr;
  readonly medium: Medium;
};

/**
 * The device's working IP interfaces, from its config and its link state now. A physical port
 * counts while its link is up, which already means it is not shut down. Switches have none yet:
 * the Vlan1 management address is left for later.
 */
export function ipInterfaces(device: Device, portUp: (port: PortId) => boolean): IpInterface[] {
  switch (device.kind) {
    case 'router': {
      const found: IpInterface[] = [];
      for (const port of device.ports) {
        const ipv4 = device.config.interfaces[port.id]?.ipv4;
        if (!ipv4 || !portUp(port.id)) continue;
        const medium: Medium =
          port.kind === 'serial'
            ? { kind: 'serial', port: port.id }
            : { kind: 'ethernet', port: port.id, mac: port.mac };
        found.push({ name: port.id, cidr: ipv4, medium });
      }
      for (const [name, config] of Object.entries(device.config.virtualInterfaces)) {
        if (!name.startsWith('Loopback') || !config?.ipv4 || config.shutdown) continue;
        found.push({ name: name as InterfaceId, cidr: config.ipv4, medium: { kind: 'loopback' } });
      }
      return found;
    }
    case 'pc':
    case 'server': {
      const { ipv4 } = device.config;
      const port = device.ports.find((candidate) => candidate.kind !== 'serial');
      if (ipv4.mode !== 'static' || !ipv4.address || !port) return [];
      if (!portUp(port.id)) return [];
      return [
        {
          name: port.id,
          cidr: ipv4.address,
          medium: { kind: 'ethernet', port: port.id, mac: port.mac },
        },
      ];
    }
    case 'switch':
      return [];
    default: {
      const exhaustive: never = device;
      return exhaustive;
    }
  }
}

export type EthernetInterface = IpInterface & {
  readonly medium: Extract<Medium, { kind: 'ethernet' }>;
};

export const isEthernet = (iface: IpInterface): iface is EthernetInterface =>
  iface.medium.kind === 'ethernet';

/** The working interface on a physical port, if any. */
export const interfaceOn = (interfaces: readonly IpInterface[], port: PortId) =>
  interfaces.find((iface) => iface.medium.kind !== 'loopback' && iface.medium.port === port);

export const ownsAddress = (interfaces: readonly IpInterface[], address: Ipv4Address) =>
  interfaces.some((iface) => iface.cidr.address === address);
