import type { DeviceKind, Ipv4Address } from '@/model';
import { ms } from '../core/time';
import type { IcmpDestinationUnreachable, IcmpTimeExceeded, Ipv4Packet, Ipv4Payload } from '../pdu';
import { sendToNeighbour } from './arp';
import { routesOf, timerKey, type IpContext } from './context';
import { isLan, ownsAddress } from './interfaces';
import { nextHop, type NextHop } from './routes';

/** The TTL a device's own packets start with: 255 on IOS, 128 on Windows. */
export const INITIAL_TTL: Record<DeviceKind, number> = {
  router: 255,
  switch: 255,
  pc: 128,
  server: 128,
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
 * Sends a packet the device itself creates, from `src` or else from the interface it leaves by.
 * A packet for one of the device's own addresses loops back on the next tick. Returns false when
 * there is no route, and the packet is dropped.
 */
export function originate(
  ctx: IpContext,
  dst: Ipv4Address,
  payload: Ipv4Payload,
  src?: Ipv4Address,
): boolean {
  const { interfaces, routes } = routesOf(ctx);
  const ttl = INITIAL_TTL[ctx.device.kind];
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
