import type {
  Device,
  InterfaceId,
  Ipv4Address,
  Ipv4Cidr,
  MacAddress,
  PortId,
  SubinterfaceId,
  VlanId,
} from '@/model';
import { parentPort } from '@/model/vlans';
import { egressFrame, ingressVlan, vlanPorts } from '../l2/switching';
import type { DeviceContext } from '../module';
import type { EthernetFrame } from '../pdu';
import { addressOf, hostPort, type HostAddressing } from './hostAddress';

/**
 * What carries an interface's packets. Ethernet and a switch's VLAN interface need ARP, a serial
 * link has one peer, and a loopback goes nowhere.
 */
export type Medium =
  /** A routed port, or a subinterface of one that tags its frames with `tag`. */
  | {
      readonly kind: 'ethernet';
      readonly port: PortId;
      readonly mac: MacAddress;
      readonly tag?: VlanId;
    }
  /** A switch's VLAN interface (SVI): it reaches every port that carries the VLAN. */
  | { readonly kind: 'svi'; readonly vlan: VlanId; readonly mac: MacAddress }
  | { readonly kind: 'serial'; readonly port: PortId }
  | { readonly kind: 'loopback' };

/** An interface that is up and has an address, so it can send, receive and own routes. */
export type IpInterface = {
  readonly name: InterfaceId;
  /** The interface's own address, with the prefix length of its subnet. */
  readonly cidr: Ipv4Cidr;
  readonly medium: Medium;
};

type Router = Extract<Device, { kind: 'router' }>;
type Switch = Extract<Device, { kind: 'switch' }>;

/** What the device's links let through now: each port's link, and each switch port per VLAN. */
export type Links = Pick<DeviceContext, 'portUp' | 'forwards'>;

/**
 * Whether the device routes between its interfaces: a router does, and so does a multilayer
 * switch with `ip routing`. Every other device only sends and receives its own packets.
 */
export const routesPackets = (device: Device): boolean =>
  device.kind === 'router' || (device.kind === 'switch' && device.config.ipRouting === true);

/** Each port with an address and its link up, as a routed interface. */
function routedPorts(
  device: Router | Switch,
  addressOf: (port: PortId) => Ipv4Cidr | undefined,
  links: Links,
): IpInterface[] {
  const found: IpInterface[] = [];
  for (const port of device.ports) {
    const ipv4 = addressOf(port.id);
    if (!ipv4 || !links.portUp(port.id)) continue;
    const medium: Medium =
      port.kind === 'serial'
        ? { kind: 'serial', port: port.id }
        : { kind: 'ethernet', port: port.id, mac: port.mac };
    found.push({ name: port.id, cidr: ipv4, medium });
  }
  return found;
}

/** A routed port's subinterfaces with an address and an encapsulation, while the port is up. */
function subinterfaces(device: Router, portUp: (port: PortId) => boolean): IpInterface[] {
  const found: IpInterface[] = [];
  for (const [name, config] of Object.entries(device.config.subinterfaces)) {
    const { ipv4, encapsulation, shutdown } = config;
    if (!ipv4 || !encapsulation || shutdown) continue;
    const port = device.ports.find(
      (candidate) => candidate.id === parentPort(name as SubinterfaceId),
    );
    if (!port || port.kind === 'serial' || !portUp(port.id)) continue;
    const medium: Medium = {
      kind: 'ethernet',
      port: port.id,
      mac: port.mac,
      ...(!encapsulation.native && { tag: encapsulation.vlan }),
    };
    found.push({ name: name as InterfaceId, cidr: ipv4, medium });
  }
  return found;
}

/** A VLAN interface answers with the switch's first Ethernet address, as `show interfaces` says. */
function sviMac(device: Switch): MacAddress | undefined {
  for (const port of device.ports) if (port.kind !== 'serial') return port.mac;
  return undefined;
}

/**
 * Each VLAN interface with an address, while its VLAN exists and a port carries it that is up and
 * forwarding in it. A port spanning tree blocks in the VLAN does not count.
 */
function svis(device: Switch, links: Links): IpInterface[] {
  const mac = sviMac(device);
  if (!mac) return [];
  const found: IpInterface[] = [];
  for (const [name, config] of Object.entries(device.config.virtualInterfaces)) {
    if (!name.startsWith('Vlan') || !config?.ipv4 || config.shutdown) continue;
    const vlan = Number(name.slice('Vlan'.length)) as VlanId;
    if (!(vlan in device.config.vlans)) continue;
    if (!vlanPorts(device, vlan).some(({ port }) => links.forwards(port, vlan))) continue;
    found.push({
      name: name as InterfaceId,
      cidr: config.ipv4,
      medium: { kind: 'svi', vlan, mac },
    });
  }
  return found;
}

/**
 * The device's working IP interfaces, from its config and its link state now. A physical port
 * counts while its link is up, which already means it is not shut down. A host's one address is
 * `host`'s, whether its config set it or DHCP did.
 */
export function ipInterfaces(
  device: Device,
  links: Links,
  host: HostAddressing | undefined,
): IpInterface[] {
  const portUp = (port: PortId) => links.portUp(port);
  switch (device.kind) {
    case 'router': {
      const found = routedPorts(device, (port) => device.config.interfaces[port]?.ipv4, links);
      found.push(...subinterfaces(device, portUp));
      for (const [name, config] of Object.entries(device.config.virtualInterfaces)) {
        if (!name.startsWith('Loopback') || !config?.ipv4 || config.shutdown) continue;
        found.push({ name: name as InterfaceId, cidr: config.ipv4, medium: { kind: 'loopback' } });
      }
      return found;
    }
    case 'pc':
    case 'server': {
      const address = host && addressOf(host);
      const port = hostPort(device);
      if (!address || !port || !portUp(port.id)) return [];
      return [
        {
          name: port.id,
          cidr: address,
          medium: { kind: 'ethernet', port: port.id, mac: port.mac },
        },
      ];
    }
    case 'switch': {
      // Only a routed port, one with no switchport, takes an address.
      const routedAddress = (port: PortId) => {
        const config = device.config.interfaces[port];
        return config && !config.switchport ? config.ipv4 : undefined;
      };
      return [...routedPorts(device, routedAddress, links), ...svis(device, links)];
    }
    default: {
      const exhaustive: never = device;
      return exhaustive;
    }
  }
}

/** An interface on an Ethernet LAN: it has a MAC address and resolves neighbours with ARP. */
export type LanInterface = IpInterface & {
  readonly medium: Extract<Medium, { kind: 'ethernet' | 'svi' }>;
};

export const isLan = (iface: IpInterface): iface is LanInterface =>
  iface.medium.kind === 'ethernet' || iface.medium.kind === 'svi';

/** The working interface on a serial port, if any. */
export const serialOn = (interfaces: readonly IpInterface[], port: PortId) =>
  interfaces.find((iface) => iface.medium.kind === 'serial' && iface.medium.port === port);

/**
 * The LAN interface an Ethernet frame that arrived on `port` belongs to. A routed port takes
 * untagged frames and each subinterface the frames tagged with its VLAN. A switchport's VLAN
 * comes from its switchport settings, and the switch's interface for that VLAN takes the frame
 * while the port forwards in the VLAN.
 */
export function lanInterfaceFor(
  ctx: Links & { readonly device: Device },
  interfaces: readonly IpInterface[],
  port: PortId,
  frame: EthernetFrame,
): LanInterface | undefined {
  const { device } = ctx;
  const switchport = device.kind === 'switch' && device.config.interfaces[port]?.switchport;
  if (switchport) {
    const vlan = ingressVlan(switchport, frame);
    if (vlan === undefined || !ctx.forwards(port, vlan)) return undefined;
    return interfaces.find(
      (iface): iface is LanInterface => iface.medium.kind === 'svi' && iface.medium.vlan === vlan,
    );
  }
  return interfaces.find(
    (iface): iface is LanInterface =>
      iface.medium.kind === 'ethernet' &&
      iface.medium.port === port &&
      iface.medium.tag === frame.tag?.vlan,
  );
}

/**
 * Sends an untagged frame out of a LAN interface. A routed port or subinterface has one port and
 * tags for a subinterface. A switch's VLAN interface sends out `port`, where the neighbour was
 * heard, or floods every port forwarding in the VLAN when `port` is undefined, tagging as each port
 * needs.
 */
export function sendOnLan(
  ctx: DeviceContext,
  iface: LanInterface,
  frame: EthernetFrame,
  port?: PortId,
) {
  const { medium } = iface;
  if (medium.kind === 'ethernet') {
    ctx.send(
      medium.port,
      medium.tag === undefined ? frame : { ...frame, tag: { vlan: medium.tag } },
    );
    return;
  }
  const { device } = ctx;
  if (device.kind !== 'switch') return;
  const bundles = new Set<string>();
  for (const out of vlanPorts(device, medium.vlan)) {
    if ((port !== undefined && out.port !== port) || !ctx.forwards(out.port, medium.vlan)) continue;
    // A flood leaves an EtherChannel by one of its members.
    const bundle = ctx.bundleOf(out.port);
    if (bundle !== undefined && bundles.has(bundle)) continue;
    if (bundle !== undefined) bundles.add(bundle);
    ctx.send(out.port, egressFrame(out.switchport, medium.vlan, frame));
  }
}

export const ownsAddress = (interfaces: readonly IpInterface[], address: Ipv4Address) =>
  interfaces.some((iface) => iface.cidr.address === address);
