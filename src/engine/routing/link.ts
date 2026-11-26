import type { Device, Ipv4Address, MacAddress, PortId } from '@/model';
import type { Frame } from '../frame';
import { isLan, lanInterfaceFor, sendOnLan, serialOn, type IpInterface } from '../l3/interfaces';
import type { DeviceContext } from '../module';
import { BROADCAST_MAC, LIMITED_BROADCAST, multicastMac, type Ipv4Packet } from '../pdu';

/**
 * How routing protocols meet the wire. They run beside the IP stack, see every frame the device
 * receives, and talk only to neighbours on their own links: by broadcast, by multicast, or to a
 * neighbour whose MAC they heard its packets come from, so they need no ARP.
 */

/** An IPv4 packet that arrived for this device, the interface it came in on, and from which MAC. */
export type Arrival = {
  readonly iface: IpInterface;
  readonly packet: Ipv4Packet;
  /** The sender's MAC, on a LAN. A serial link has none. */
  readonly mac?: MacAddress;
};

/** The IPv4 packet a frame carries, if any. */
export const packetIn = (frame: Frame): Ipv4Packet | undefined =>
  frame.kind === 'hdlc'
    ? frame.payload
    : frame.kind === 'ethernet' && frame.payload.kind === 'ipv4'
      ? frame.payload
      : undefined;

/**
 * The IPv4 packet in a frame that arrived on `port`, when the frame is for this device: anything
 * on a serial link, and on a LAN a frame to the interface's own MAC, to broadcast, or to the MAC
 * of one of the multicast `groups` the protocol joined.
 */
export function arrival(
  device: Device,
  interfaces: readonly IpInterface[],
  port: PortId,
  frame: Frame,
  groups: readonly Ipv4Address[],
): Arrival | undefined {
  if (frame.kind === 'hdlc') {
    const iface = serialOn(interfaces, port);
    return iface && { iface, packet: frame.payload };
  }
  if (frame.kind !== 'ethernet' || frame.payload.kind !== 'ipv4') return undefined;
  const iface = lanInterfaceFor(device, interfaces, port, frame);
  if (!iface) return undefined;
  const packet = frame.payload;
  const joined = groups.some((group) => packet.dst === group && frame.dst === multicastMac(group));
  const forUs = frame.dst === iface.medium.mac || frame.dst === BROADCAST_MAC || joined;
  return forUs ? { iface, packet, mac: frame.src } : undefined;
}

/**
 * Sends a packet out of one interface to its link: to broadcast or a multicast group by the
 * packet's destination, or to the neighbour at `mac`. A loopback sends nothing.
 */
export function sendOn(
  ctx: DeviceContext,
  iface: IpInterface,
  packet: Ipv4Packet,
  mac?: MacAddress,
): void {
  if (iface.medium.kind === 'serial') {
    ctx.send(iface.medium.port, { kind: 'hdlc', payload: packet });
    return;
  }
  if (!isLan(iface)) return;
  const dst = mac ?? (packet.dst === LIMITED_BROADCAST ? BROADCAST_MAC : multicastMac(packet.dst));
  sendOnLan(ctx, iface, { kind: 'ethernet', dst, src: iface.medium.mac, payload: packet });
}
