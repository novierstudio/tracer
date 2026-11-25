import type { InterfaceId, Ipv4Address, MacAddress, PortId } from '@/model';
import type { SimTime } from '../core/time';
import type { ModuleContext } from '../module';
import type { Ipv4Packet } from '../pdu';
import { ipInterfaces, type IpInterface } from './interfaces';
import type { PingSession } from './ping';
import { routingTable, type Route } from './routes';

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
  readonly pings: Map<number, PingSession>;
  /** Packets the device sent to one of its own addresses, delivered on the next tick. */
  readonly loopback: Ipv4Packet[];
  nextPacketId: number;
  nextPingId: number;
};

export type IpContext = ModuleContext<IpState>;

/** The timers an IP stack sets, one key per pending thing. */
export type IpTimer =
  | { readonly kind: 'arp'; readonly address: Ipv4Address }
  | { readonly kind: 'ping'; readonly id: number }
  | { readonly kind: 'loopback' };

export function timerKey(timer: IpTimer): string {
  switch (timer.kind) {
    case 'arp':
      return `arp ${timer.address}`;
    case 'ping':
      return `ping ${timer.id}`;
    case 'loopback':
      return 'loopback';
  }
}

export function parseTimer(key: string): IpTimer | undefined {
  const [kind, value = ''] = key.split(' ');
  switch (kind) {
    case 'arp':
      return { kind, address: value as Ipv4Address };
    case 'ping':
      return { kind, id: Number(value) };
    case 'loopback':
      return { kind };
    default:
      return undefined;
  }
}

export const interfacesOf = (ctx: IpContext): IpInterface[] =>
  ipInterfaces(ctx.device, (port) => ctx.portUp(port));

export function routesOf(ctx: IpContext): { interfaces: IpInterface[]; routes: Route[] } {
  const interfaces = interfacesOf(ctx);
  return { interfaces, routes: routingTable(ctx.device, interfaces) };
}
