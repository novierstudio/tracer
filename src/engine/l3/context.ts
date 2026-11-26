import type { InterfaceId, Ipv4Address, MacAddress, PortId } from '@/model';
import type { SimTime } from '../core/time';
import type { ModuleContext } from '../module';
import type { Ipv4Packet } from '../pdu';
import type { DhcpClient, DhcpListener } from './dhcpClient';
import type { DhcpBinding } from './dhcpServer';
import { hostAddressing, isHost, type HostAddressing } from './hostAddress';
import { ipInterfaces, type IpInterface } from './interfaces';
import type { PingSession } from './ping';
import { routingTable, type Route } from './routes';
import type { TraceSession } from './traceroute';

export type ArpEntry = {
  readonly mac: MacAddress;
  /** The interface whose subnet the neighbour is on. */
  readonly interface: InterfaceId;
  /** The port the neighbour was heard on. A switch's VLAN interface sends to it there. */
  readonly port: PortId;
  readonly learnedAt: SimTime;
};

/** An address being resolved: the packets waiting for it and how many requests went out. */
export type Resolution = {
  readonly interface: InterfaceId;
  tries: number;
  readonly waiting: Ipv4Packet[];
};

/** One device's IP stack. Its interfaces and routes are not kept: they derive from config and links. */
export type IpState = {
  readonly arp: Map<Ipv4Address, ArpEntry>;
  readonly resolving: Map<Ipv4Address, Resolution>;
  /** Pings and traceroutes in flight, by the identifier their echo requests carry. */
  readonly probes: Map<number, Probe>;
  /** Packets the device sent to one of its own addresses, delivered on the next tick. */
  readonly loopback: Ipv4Packet[];
  nextPacketId: number;
  nextProbeId: number;
  /** A host's DHCP client. It stays stopped unless the host's config asks for DHCP. */
  dhcp: DhcpClient;
  /** What waits on the client's next lease or failure, as `ipconfig /renew` does. */
  readonly dhcpWaiters: DhcpListener[];
  /** A router's DHCP server: the addresses it has offered or leased, by client MAC. */
  readonly bindings: Map<MacAddress, DhcpBinding>;
};

/** Something that sends echo requests and waits on their answers. */
export type Probe = PingSession | TraceSession;

export type IpContext = ModuleContext<IpState>;

/** The timers an IP stack sets, one key per pending thing. */
export type IpTimer =
  | { readonly kind: 'arp'; readonly address: Ipv4Address }
  | { readonly kind: 'probe'; readonly id: number }
  | { readonly kind: 'loopback' }
  /** The DHCP client's one pending step: a retry, a renewal, or the lease running out. */
  | { readonly kind: 'dhcp' };

export function timerKey(timer: IpTimer): string {
  switch (timer.kind) {
    case 'arp':
      return `arp ${timer.address}`;
    case 'probe':
      return `probe ${timer.id}`;
    case 'loopback':
    case 'dhcp':
      return timer.kind;
  }
}

export function parseTimer(key: string): IpTimer | undefined {
  const [kind, value = ''] = key.split(' ');
  switch (kind) {
    case 'arp':
      return { kind, address: value as Ipv4Address };
    case 'probe':
      return { kind, id: Number(value) };
    case 'loopback':
    case 'dhcp':
      return { kind };
    default:
      return undefined;
  }
}

/** A host's live IPv4 settings. Undefined for a router or a switch. */
export const hostAddressingOf = (ctx: IpContext): HostAddressing | undefined =>
  isHost(ctx.device) ? hostAddressing(ctx.device, ctx.state.dhcp) : undefined;

export const interfacesOf = (ctx: IpContext): IpInterface[] =>
  ipInterfaces(ctx.device, (port) => ctx.portUp(port), hostAddressingOf(ctx));

export function routesOf(ctx: IpContext): { interfaces: IpInterface[]; routes: Route[] } {
  const host = hostAddressingOf(ctx);
  const interfaces = ipInterfaces(ctx.device, (port) => ctx.portUp(port), host);
  const routes = routingTable(ctx.device, interfaces, host, ctx.learnedRoutes());
  return { interfaces, routes };
}
