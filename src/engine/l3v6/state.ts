import type { InterfaceId, MacAddress, PortId } from '@/model';
import type { Ipv6Address } from '@/model/ipv6';
import type { SimTime } from '../core/time';
import type { ModuleContext } from '../module';
import type { Ipv6Packet } from '../pdu6';
import type { Probe6 } from './probes';

/** A neighbour's link-layer address, learned from Neighbor Discovery on one interface. */
export type Neighbor = {
  readonly address: Ipv6Address;
  readonly interface: InterfaceId;
  readonly mac: MacAddress;
  /** The port it was heard on. */
  readonly port: PortId;
  /** When it was last confirmed reachable: a solicited advertisement, or a message it sent. */
  readonly confirmedAt: SimTime;
  readonly router: boolean;
};

/** A packet waiting for its next hop's link-layer address. `forwarded` if this device routed it. */
export type Waiting = { readonly packet: Ipv6Packet; readonly forwarded: boolean };

/** A next hop being resolved: the packets waiting for it and how many solicitations went out. */
export type Resolution = {
  readonly interface: InterfaceId;
  readonly address: Ipv6Address;
  tries: number;
  readonly waiting: Waiting[];
};

/** A prefix a router advertised, from which SLAAC formed an address on one interface. */
export type SlaacPrefix = {
  /** The /64 network, host bits clear. The address is it plus the interface's EUI-64 identifier. */
  readonly prefix: Ipv6Address;
  /** The router that advertised it, by its link-local address. */
  readonly router: Ipv6Address;
};

/** The router a host took from a router advertisement, as its default gateway. */
export type DefaultRouter = { readonly address: Ipv6Address; readonly interface: InterfaceId };

/**
 * One device's IPv6 stack. Its interfaces and routes are not kept: they derive from config, link
 * state and what SLAAC learned, on each use.
 */
export type Ipv6State = {
  /** By `neighborKey`: link-local addresses repeat across links, so the interface is in the key. */
  readonly neighbors: Map<string, Neighbor>;
  readonly resolving: Map<string, Resolution>;
  readonly probes: Map<number, Probe6>;
  /** Packets the device sent to one of its own addresses, delivered on the next tick. */
  readonly loopback: Ipv6Packet[];
  nextProbeId: number;
  /** SLAAC prefixes by interface. */
  readonly slaac: Map<InterfaceId, SlaacPrefix[]>;
  /** A host's router from advertisements. A static gateway in the config wins over it. */
  defaultRouter: DefaultRouter | undefined;
  /** Router solicitations sent on each interface since it came up, while it waits for an answer. */
  readonly solicited: Map<InterfaceId, number>;
  /**
   * A router's advertisements: how many went out since what it advertises last changed, and
   * what that was, so a change starts the quick initial advertisements again.
   */
  advertised: { count: number; signature: string } | undefined;
};

export type Ipv6Context = ModuleContext<Ipv6State>;

export const neighborKey = (iface: InterfaceId, address: Ipv6Address) => `${iface} ${address}`;

/** The timers an IPv6 stack sets, one key per pending thing. */
export type Ipv6Timer =
  | { readonly kind: 'nd'; readonly interface: InterfaceId; readonly address: Ipv6Address }
  | { readonly kind: 'probe'; readonly id: number }
  | { readonly kind: 'loopback' }
  /** The device came up: it starts soliciting and advertising. */
  | { readonly kind: 'boot' }
  /** A router's next unsolicited advertisement on every interface. */
  | { readonly kind: 'ra' }
  /** The next router solicitation on an interface. */
  | { readonly kind: 'rs'; readonly interface: InterfaceId };

export function timerKey(timer: Ipv6Timer): string {
  switch (timer.kind) {
    case 'nd':
      return `nd ${timer.interface} ${timer.address}`;
    case 'probe':
      return `probe ${timer.id}`;
    case 'rs':
      return `rs ${timer.interface}`;
    case 'loopback':
    case 'boot':
    case 'ra':
      return timer.kind;
  }
}

export function parseTimer(key: string): Ipv6Timer | undefined {
  const [kind, first = '', second = ''] = key.split(' ');
  switch (kind) {
    case 'nd':
      return { kind, interface: first as InterfaceId, address: second as Ipv6Address };
    case 'probe':
      return { kind, id: Number(first) };
    case 'rs':
      return { kind, interface: first as InterfaceId };
    case 'loopback':
    case 'boot':
    case 'ra':
      return { kind };
    default:
      return undefined;
  }
}

export const emptyIpv6State = (): Ipv6State => ({
  neighbors: new Map(),
  resolving: new Map(),
  probes: new Map(),
  loopback: [],
  nextProbeId: 1,
  slaac: new Map(),
  defaultRouter: undefined,
  solicited: new Map(),
  advertised: undefined,
});
