import type {
  Device,
  InterfaceId,
  Ipv6InterfaceConfig,
  MacAddress,
  PortId,
  SubinterfaceId,
  VlanId,
} from '@/model';
import {
  ALL_NODES,
  ALL_ROUTERS,
  compareIpv6,
  configuredIpv6Addresses,
  eui64Address,
  eui64Mac,
  interfaceLinkLocal,
  ipv6Enabled,
  linkLocalOf,
  solicitedNode,
  type Ipv6Address,
} from '@/model/ipv6';
import { parentPort } from '@/model/vlans';
import type { DeviceContext } from '../module';
import type { EthernetFrame } from '../pdu';
import type { Ipv6Packet } from '../pdu6';
import type { Ipv6State } from './state';
import type { Ipv6AddressEntry } from './status';

/** What carries an interface's packets: Ethernet resolves neighbours, a serial link has one peer. */
export type Ipv6Medium =
  /** A routed port or a host's port, or a subinterface of a port that tags with `tag`. */
  | {
      readonly kind: 'ethernet';
      readonly port: PortId;
      readonly mac: MacAddress;
      readonly tag?: VlanId;
    }
  | { readonly kind: 'serial'; readonly port: PortId }
  | { readonly kind: 'loopback' };

/** An interface with IPv6 enabled, whether or not it is up. */
export type Ipv6Interface = {
  readonly name: InterfaceId;
  readonly medium: Ipv6Medium;
  /** Whether it sends and receives now: its link is up and it is not shut down. */
  readonly up: boolean;
  readonly linkLocal: Ipv6Address;
  /** Global addresses: the configured ones in the order entered, then SLAAC's. */
  readonly addresses: readonly Ipv6AddressEntry[];
  /** It forms addresses from router advertisements: a host set to automatic, or `autoconfig`. */
  readonly autoconfig: boolean;
};

export type LanInterface6 = Ipv6Interface & {
  readonly medium: Extract<Ipv6Medium, { kind: 'ethernet' }>;
};

export const isLan6 = (iface: Ipv6Interface): iface is LanInterface6 =>
  iface.medium.kind === 'ethernet';

type Router = Extract<Device, { kind: 'router' }>;

/**
 * Whether the device forwards IPv6 between its interfaces and advertises its prefixes: a router
 * with `ipv6 unicast-routing`. Every other device only sends and receives its own packets.
 */
export const routesIpv6 = (device: Device): boolean =>
  device.kind === 'router' && device.config.ipv6UnicastRouting === true;

function slaacAddresses(state: Ipv6State, name: InterfaceId, mac: MacAddress): Ipv6AddressEntry[] {
  return (state.slaac.get(name) ?? []).map(({ prefix }) => ({
    address: eui64Address(prefix, mac),
    prefixLength: 64,
    origin: 'autoconfig',
  }));
}

function routerInterface(
  device: Router,
  state: Ipv6State,
  name: InterfaceId,
  config: Ipv6InterfaceConfig,
  medium: Ipv6Medium,
  up: boolean,
): Ipv6Interface | undefined {
  const mac = eui64Mac(device.ports, medium.kind === 'loopback' ? undefined : medium.port);
  if (!mac) return undefined;
  const configured = configuredIpv6Addresses(config, mac).map(
    ({ eui64, ...cidr }): Ipv6AddressEntry => ({ ...cidr, origin: eui64 ? 'eui64' : 'manual' }),
  );
  const autoconfig = config.autoconfig === true;
  const learned = autoconfig ? slaacAddresses(state, name, mac) : [];
  return {
    name,
    medium,
    up,
    linkLocal: interfaceLinkLocal(config, mac),
    addresses: [...configured, ...learned],
    autoconfig,
  };
}

function routerInterfaces(device: Router, links: Links, state: Ipv6State): Ipv6Interface[] {
  const found: Ipv6Interface[] = [];
  const add = (iface: Ipv6Interface | undefined) => iface && found.push(iface);
  for (const [name, config] of Object.entries(device.config.virtualInterfaces)) {
    if (!name.startsWith('Loopback') || !config || !ipv6Enabled(config.ipv6)) continue;
    const medium: Ipv6Medium = { kind: 'loopback' };
    add(
      routerInterface(device, state, name as InterfaceId, config.ipv6!, medium, !config.shutdown),
    );
  }
  for (const port of device.ports) {
    const config = device.config.interfaces[port.id];
    if (config && ipv6Enabled(config.ipv6)) {
      const medium: Ipv6Medium =
        port.kind === 'serial'
          ? { kind: 'serial', port: port.id }
          : { kind: 'ethernet', port: port.id, mac: port.mac };
      add(routerInterface(device, state, port.id, config.ipv6!, medium, links.portUp(port.id)));
    }
    if (port.kind === 'serial') continue;
    for (const [name, sub] of Object.entries(device.config.subinterfaces)) {
      if (parentPort(name as SubinterfaceId) !== port.id || !ipv6Enabled(sub.ipv6)) continue;
      const { encapsulation } = sub;
      if (!encapsulation) continue;
      const medium: Ipv6Medium = {
        kind: 'ethernet',
        port: port.id,
        mac: port.mac,
        ...(!encapsulation.native && { tag: encapsulation.vlan }),
      };
      const up = !sub.shutdown && links.portUp(port.id);
      add(routerInterface(device, state, name as InterfaceId, sub.ipv6!, medium, up));
    }
  }
  return found;
}

/** What the device's links let through now. */
export type Links = Pick<DeviceContext, 'portUp'>;

/**
 * The device's IPv6 interfaces, from its config, its link state and what SLAAC learned, in port
 * order. A host always has one on its first Ethernet port, with a link-local address from its MAC.
 * A switch runs no IPv6.
 */
export function ipv6Interfaces(device: Device, links: Links, state: Ipv6State): Ipv6Interface[] {
  switch (device.kind) {
    case 'router':
      return routerInterfaces(device, links, state);
    case 'pc':
    case 'server': {
      const port = device.ports.find((candidate) => candidate.kind !== 'serial');
      if (!port) return [];
      const ipv6 = device.config.ipv6;
      const autoconfig = ipv6?.mode === 'auto';
      const configured: Ipv6AddressEntry[] =
        ipv6?.mode === 'static' && ipv6.address ? [{ ...ipv6.address, origin: 'manual' }] : [];
      const learned = autoconfig ? slaacAddresses(state, port.id, port.mac) : [];
      return [
        {
          name: port.id,
          medium: { kind: 'ethernet', port: port.id, mac: port.mac },
          up: links.portUp(port.id),
          linkLocal: linkLocalOf(port.mac),
          addresses: [...configured, ...learned],
          autoconfig,
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

/** Every address of the interface: link-local first, then global. */
export const addressesOf = (iface: Ipv6Interface): Ipv6Address[] => [
  iface.linkLocal,
  ...iface.addresses.map((entry) => entry.address),
];

/** Whether one of the up interfaces has `address`. */
export const ownsAddress6 = (interfaces: readonly Ipv6Interface[], address: Ipv6Address) =>
  interfaces.some((iface) => iface.up && addressesOf(iface).includes(address));

/**
 * The multicast groups an interface listens to: all nodes, all routers on a routing device, and
 * the solicited-node group of each of its addresses. Sorted, as IOS lists them.
 */
export function groupsOf(iface: Ipv6Interface, routing: boolean): Ipv6Address[] {
  const groups = new Set<Ipv6Address>([ALL_NODES]);
  if (routing) groups.add(ALL_ROUTERS);
  for (const address of addressesOf(iface)) groups.add(solicitedNode(address));
  return [...groups].sort(compareIpv6);
}

/** The up LAN interface an Ethernet frame that arrived on `port` belongs to, by port and tag. */
export function lanInterfaceOn(
  interfaces: readonly Ipv6Interface[],
  port: PortId,
  frame: EthernetFrame,
): LanInterface6 | undefined {
  return interfaces.find(
    (iface): iface is LanInterface6 =>
      iface.up &&
      iface.medium.kind === 'ethernet' &&
      iface.medium.port === port &&
      iface.medium.tag === frame.tag?.vlan,
  );
}

/** The up serial interface on a port. */
export const serialOn6 = (interfaces: readonly Ipv6Interface[], port: PortId) =>
  interfaces.find(
    (iface) => iface.up && iface.medium.kind === 'serial' && iface.medium.port === port,
  );

/** Puts a packet on an interface's wire: to `mac` on Ethernet, or to the one peer of a serial link. */
export function sendOn(
  ctx: DeviceContext,
  iface: Ipv6Interface,
  packet: Ipv6Packet,
  mac?: MacAddress,
) {
  const { medium } = iface;
  switch (medium.kind) {
    case 'ethernet': {
      if (!mac) return;
      const frame: EthernetFrame = { kind: 'ethernet', dst: mac, src: medium.mac, payload: packet };
      ctx.send(
        medium.port,
        medium.tag === undefined ? frame : { ...frame, tag: { vlan: medium.tag } },
      );
      return;
    }
    case 'serial':
      ctx.send(medium.port, { kind: 'hdlc', payload: packet });
      return;
    case 'loopback':
      return;
  }
}
