import { isIpv6Multicast, UNSPECIFIED_IPV6, type Ipv6Address } from '@/model/ipv6';
import { ms } from '../core/time';
import { INITIAL_TTL } from '../l3/output';
import type {
  Icmpv6DestinationUnreachable,
  Icmpv6TimeExceeded,
  Ipv6Packet,
  Ipv6Payload,
} from '../pdu6';
import { ipv6Interfaces, isLan6, ownsAddress6, sendOn, type Ipv6Interface } from './interfaces';
import { sendToNeighbor6, sourceFor } from './nd';
import { ipv6RoutingTable, nextHop6, type NextHop6 } from './routes';
import { timerKey, type Ipv6Context } from './state';
import type { Ipv6Route } from './status';

export const interfacesOf6 = (ctx: Ipv6Context): Ipv6Interface[] =>
  ipv6Interfaces(ctx.device, ctx, ctx.state);

export function routesOf6(ctx: Ipv6Context): {
  interfaces: Ipv6Interface[];
  routes: Ipv6Route[];
} {
  const interfaces = interfacesOf6(ctx);
  return { interfaces, routes: ipv6RoutingTable(ctx.device, interfaces, ctx.state.defaultRouter) };
}

/**
 * Hands a packet to the next hop: on a LAN once Neighbor Discovery has the neighbour's MAC, on a
 * serial link straight away. `forwarded` is whether this device routed it rather than sent it.
 */
export function transmit6(ctx: Ipv6Context, hop: NextHop6, packet: Ipv6Packet, forwarded: boolean) {
  const { interface: iface, address } = hop;
  if (isLan6(iface)) sendToNeighbor6(ctx, iface, address, { packet, forwarded });
  else sendOn(ctx, iface, packet);
}

/**
 * Sends a packet the device itself creates, from `src` or else the address the exit interface
 * picks for `dst`, with the device's initial hop limit unless `hopLimit` says otherwise. A packet
 * for one of the device's own addresses loops back on the next tick. Returns false when there is
 * no route, and the packet is dropped.
 */
export function originate6(
  ctx: Ipv6Context,
  dst: Ipv6Address,
  payload: Ipv6Payload,
  { src, hopLimit = INITIAL_TTL[ctx.device.kind] }: { src?: Ipv6Address; hopLimit?: number } = {},
): boolean {
  const { interfaces, routes } = routesOf6(ctx);
  if (ownsAddress6(interfaces, dst)) {
    ctx.state.loopback.push({ kind: 'ipv6', src: src ?? dst, dst, hopLimit, payload });
    ctx.setTimer(timerKey({ kind: 'loopback' }), ms(0));
    return true;
  }
  const hop = nextHop6(routes, interfaces, dst);
  if (!hop) return false;
  const from = src ?? sourceFor(hop.interface, dst);
  transmit6(ctx, hop, { kind: 'ipv6', src: from, dst, hopLimit, payload }, false);
  return true;
}

/** Errors and Neighbor Discovery never draw an error back, so errors cannot loop (RFC 4443). */
const mayReportOn = (packet: Ipv6Packet) =>
  packet.src !== UNSPECIFIED_IPV6 &&
  !isIpv6Multicast(packet.src) &&
  !isIpv6Multicast(packet.dst) &&
  (packet.payload.type === 'echo-request' || packet.payload.type === 'echo-reply');

/** Tells a dropped packet's sender why. */
export function reportError6(
  ctx: Ipv6Context,
  message: Icmpv6DestinationUnreachable | Icmpv6TimeExceeded,
) {
  if (mayReportOn(message.original)) originate6(ctx, message.original.src, message);
}
