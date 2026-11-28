import type { DeviceKind, Ipv4Address } from '@/model';
import { ms } from '../core/time';
import {
  BROADCAST_MAC,
  LIMITED_BROADCAST,
  type IcmpDestinationUnreachable,
  type IcmpTimeExceeded,
  type Ipv4Packet,
  type Ipv4Payload,
} from '../pdu';
import { sendToNeighbour } from './arp';
import { routesOf, timerKey, type IpContext } from './context';
import { isLan, ownsAddress, sendOnLan, type LanInterface } from './interfaces';
import { nextHop, type NextHop } from './routes';

/** The TTL a device's own packets start with: 255 on IOS, 128 on Windows, 64 on a home router. */
export const INITIAL_TTL: Record<DeviceKind, number> = {
  router: 255,
  switch: 255,
  pc: 128,
  server: 128,
  wirelessRouter: 64,
  centralOffice: 64,
  lightweightAp: 255,
  wlc: 64,
  // A hub, an access point and a cell tower run no IP.
  hub: 0,
  accessPoint: 0,
  cellTower: 0,
};

/** Hands a packet to the next hop. A LAN resolves the neighbour's MAC first. */
export function transmit(
  ctx: IpContext,
  { interface: iface, address }: NextHop,
  packet: Ipv4Packet,
) {
  if (isLan(iface)) sendToNeighbour(ctx, iface, address, packet);
  else if (iface.medium.kind === 'serial')
    ctx.send(iface.medium.port, { kind: 'hdlc', payload: packet });
  // A route out of a loopback interface leads nowhere.
}

/**
 * Sends a packet the device itself creates, from `src` or else from the interface it leaves by,
 * with the device's initial TTL unless `ttl` says otherwise. A packet for one of the device's own
 * addresses loops back on the next tick. Returns false when there is no route, and the packet is
 * dropped.
 */
export function originate(
  ctx: IpContext,
  dst: Ipv4Address,
  payload: Ipv4Payload,
  { src, ttl = INITIAL_TTL[ctx.device.kind] }: { src?: Ipv4Address; ttl?: number } = {},
): boolean {
  const { interfaces, routes } = routesOf(ctx);
  if (ownsAddress(interfaces, dst)) {
    ctx.state.loopback.push({
      kind: 'ipv4',
      src: src ?? dst,
      dst,
      ttl,
      id: ctx.state.nextPacketId++,
      payload,
    });
    ctx.setTimer(timerKey({ kind: 'loopback' }), ms(0));
    return true;
  }
  const hop = nextHop(routes, interfaces, dst);
  if (!hop) return false;
  const from = src ?? hop.interface.cidr.address;
  transmit(ctx, hop, { kind: 'ipv4', src: from, dst, ttl, id: ctx.state.nextPacketId++, payload });
  return true;
}

const isIcmpError = (payload: Ipv4Payload) =>
  payload.kind === 'icmp' &&
  (payload.type === 'destination-unreachable' || payload.type === 'time-exceeded');

/** Tells a dropped packet's sender why. Never about another ICMP error, so errors cannot loop. */
export function reportError(
  ctx: IpContext,
  message: IcmpDestinationUnreachable | IcmpTimeExceeded,
) {
  if (!isIcmpError(message.original.payload)) originate(ctx, message.original.src, message);
}

/** Sends a packet to every host on a LAN interface's network, as a DHCP server answers a client. */
export function broadcastOn(ctx: IpContext, iface: LanInterface, payload: Ipv4Payload) {
  const packet: Ipv4Packet = {
    kind: 'ipv4',
    src: iface.cidr.address,
    dst: LIMITED_BROADCAST,
    ttl: INITIAL_TTL[ctx.device.kind],
    id: ctx.state.nextPacketId++,
    payload,
  };
  sendOnLan(ctx, iface, {
    kind: 'ethernet',
    dst: BROADCAST_MAC,
    src: iface.medium.mac,
    payload: packet,
  });
}
