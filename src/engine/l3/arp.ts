import type { DeviceKind, InterfaceId, Ipv4Address, MacAddress, PortId } from '@/model';
import { ms, type SimDuration } from '../core/time';
import {
  BROADCAST_MAC,
  UNKNOWN_MAC,
  type ArpPacket,
  type EthernetFrame,
  type EthernetPayload,
  type Ipv4Packet,
} from '../pdu';
import { interfacesOf, routesOf, timerKey, type IpContext } from './context';
import { isLan, sendOnLan, type LanInterface } from './interfaces';
import { compareAddresses, inPrefix } from './ipv4';
import { nextHop } from './routes';

/** How long a learned address is trusted: 4 hours on IOS, about 2 minutes on a Windows host. */
export const ARP_TIMEOUT: Record<DeviceKind, SimDuration> = {
  router: ms(4 * 60 * 60_000),
  switch: ms(4 * 60 * 60_000),
  pc: ms(2 * 60_000),
  server: ms(2 * 60_000),
};

/** A request unanswered for this long is sent again, up to ARP_TRIES requests in all. */
export const ARP_RETRY = ms(1000);
export const ARP_TRIES = 3;

/** Packets held per address while it resolves. Past this, new ones are dropped. */
const WAITING_LIMIT = 16;

export type ArpTableEntry =
  /** The device's own address on a LAN interface, which IOS lists with no age. */
  | {
      readonly kind: 'interface';
      readonly address: Ipv4Address;
      readonly mac: MacAddress;
      readonly interface: InterfaceId;
    }
  | {
      readonly kind: 'dynamic';
      readonly address: Ipv4Address;
      readonly mac: MacAddress;
      readonly interface: InterfaceId;
      readonly ageMs: number;
    };

const ethernet = (src: MacAddress, dst: MacAddress, payload: EthernetPayload): EthernetFrame => ({
  kind: 'ethernet',
  dst,
  src,
  payload,
});

function cached(ctx: IpContext, address: Ipv4Address, iface: InterfaceId) {
  const entry = ctx.state.arp.get(address);
  if (!entry || entry.interface !== iface) return undefined;
  if (ctx.now - entry.learnedAt < ARP_TIMEOUT[ctx.device.kind]) return entry;
  ctx.state.arp.delete(address);
  return undefined;
}

function request(ctx: IpContext, iface: LanInterface, address: Ipv4Address) {
  const { mac } = iface.medium;
  const arp: ArpPacket = {
    kind: 'arp',
    op: 'request',
    senderMac: mac,
    senderIp: iface.cidr.address,
    targetMac: UNKNOWN_MAC,
    targetIp: address,
  };
  sendOnLan(ctx, iface, ethernet(mac, BROADCAST_MAC, arp));
  ctx.setTimer(timerKey({ kind: 'arp', address }), ARP_RETRY);
}

/**
 * Sends a packet to a neighbour on a LAN interface. With the neighbour's MAC unknown, the packet
 * waits while ARP asks for it, rather than being dropped as IOS would drop it.
 */
export function sendToNeighbour(
  ctx: IpContext,
  iface: LanInterface,
  address: Ipv4Address,
  packet: Ipv4Packet,
) {
  const known = cached(ctx, address, iface.name);
  if (known) {
    sendOnLan(ctx, iface, ethernet(iface.medium.mac, known.mac, packet), known.port);
    return;
  }
  const pending = ctx.state.resolving.get(address);
  if (pending) {
    if (pending.waiting.length < WAITING_LIMIT) pending.waiting.push(packet);
    return;
  }
  ctx.state.resolving.set(address, { interface: iface.name, tries: 1, waiting: [packet] });
  request(ctx, iface, address);
}

/** A request went unanswered: ask again, or give up after the last try and drop what waited. */
export function onArpTimer(ctx: IpContext, address: Ipv4Address) {
  const pending = ctx.state.resolving.get(address);
  if (!pending) return;
  const iface = interfacesOf(ctx).find((candidate) => candidate.name === pending.interface);
  if (!iface || !isLan(iface) || pending.tries >= ARP_TRIES) {
    ctx.state.resolving.delete(address);
    ctx.note(
      `ARP for ${address} went unanswered after ${pending.tries} tries; dropped ${pending.waiting.length} packet(s)`,
    );
    return;
  }
  pending.tries += 1;
  request(ctx, iface, address);
}

function learn(
  ctx: IpContext,
  iface: LanInterface,
  port: PortId,
  address: Ipv4Address,
  mac: MacAddress,
) {
  ctx.state.arp.set(address, { mac, interface: iface.name, port, learnedAt: ctx.now });
  const pending = ctx.state.resolving.get(address);
  if (pending?.interface !== iface.name) return;
  ctx.state.resolving.delete(address);
  ctx.clearTimer(timerKey({ kind: 'arp', address }));
  for (const packet of pending.waiting) {
    sendOnLan(ctx, iface, ethernet(iface.medium.mac, mac, packet), port);
  }
}

/** IOS answers for an address it routes out another interface (`ip proxy-arp`, on by default). */
function proxies(ctx: IpContext, iface: LanInterface, target: Ipv4Address): boolean {
  if (ctx.device.kind !== 'router' || inPrefix(iface.cidr, target)) return false;
  const { interfaces, routes } = routesOf(ctx);
  const hop = nextHop(routes, interfaces, target);
  return hop !== undefined && hop.interface.name !== iface.name;
}

/**
 * An ARP packet arrived on `port`. The sender is learned when the packet is for this device or
 * the sender is already known (RFC 826), and a request for one of its addresses gets a reply.
 */
export function onArp(ctx: IpContext, iface: LanInterface, port: PortId, arp: ArpPacket) {
  const forUs = arp.targetIp === iface.cidr.address;
  if (forUs || ctx.state.arp.has(arp.senderIp)) {
    learn(ctx, iface, port, arp.senderIp, arp.senderMac);
  }
  if (arp.op !== 'request' || !(forUs || proxies(ctx, iface, arp.targetIp))) return;
  const { mac } = iface.medium;
  const reply: ArpPacket = {
    kind: 'arp',
    op: 'reply',
    senderMac: mac,
    senderIp: arp.targetIp,
    targetMac: arp.senderMac,
    targetIp: arp.senderIp,
  };
  sendOnLan(ctx, iface, ethernet(mac, arp.senderMac, reply), port);
}

/**
 * A port went down: what was learned on it is gone, and so is what waited to go out of an
 * interface that went down with it.
 */
export function forgetPort(ctx: IpContext, port: PortId) {
  const { arp, resolving } = ctx.state;
  for (const [address, entry] of arp) if (entry.port === port) arp.delete(address);
  const working = new Set(interfacesOf(ctx).map((iface) => iface.name));
  for (const [address, pending] of resolving) {
    if (working.has(pending.interface)) continue;
    resolving.delete(address);
    ctx.clearTimer(timerKey({ kind: 'arp', address }));
  }
}

/** The device's own Ethernet addresses and what it has learned, by address, for `show arp`. */
export function arpTable(ctx: IpContext): ArpTableEntry[] {
  const own = interfacesOf(ctx)
    .filter(isLan)
    .map(({ name, cidr, medium }): ArpTableEntry => ({
      kind: 'interface',
      address: cidr.address,
      mac: medium.mac,
      interface: name,
    }));
  const timeout = ARP_TIMEOUT[ctx.device.kind];
  const learned = [...ctx.state.arp].flatMap(
    ([address, { mac, interface: name, learnedAt }]): ArpTableEntry[] => {
      const ageMs = ctx.now - learnedAt;
      return ageMs < timeout ? [{ kind: 'dynamic', address, mac, interface: name, ageMs }] : [];
    },
  );
  return [...own, ...learned].sort((a, b) => compareAddresses(a.address, b.address));
}
