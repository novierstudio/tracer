import type { DeviceKind, Ipv4Address, MacAddress, PortId } from '@/model';
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
import { interfaceOn, isEthernet, type EthernetInterface } from './interfaces';
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
  /** The device's own address on an Ethernet interface, which IOS lists with no age. */
  | {
      readonly kind: 'interface';
      readonly address: Ipv4Address;
      readonly mac: MacAddress;
      readonly port: PortId;
    }
  | {
      readonly kind: 'dynamic';
      readonly address: Ipv4Address;
      readonly mac: MacAddress;
      readonly port: PortId;
      readonly ageMs: number;
    };

const ethernet = (src: MacAddress, dst: MacAddress, payload: EthernetPayload): EthernetFrame => ({
  kind: 'ethernet',
  dst,
  src,
  payload,
});

function cachedMac(ctx: IpContext, address: Ipv4Address, port: PortId): MacAddress | undefined {
  const entry = ctx.state.arp.get(address);
  if (!entry || entry.port !== port) return undefined;
  if (ctx.now - entry.learnedAt < ARP_TIMEOUT[ctx.device.kind]) return entry.mac;
  ctx.state.arp.delete(address);
  return undefined;
}

function request(ctx: IpContext, iface: EthernetInterface, address: Ipv4Address) {
  const { mac, port } = iface.medium;
  const arp: ArpPacket = {
    kind: 'arp',
    op: 'request',
    senderMac: mac,
    senderIp: iface.cidr.address,
    targetMac: UNKNOWN_MAC,
    targetIp: address,
  };
  ctx.send(port, ethernet(mac, BROADCAST_MAC, arp));
  ctx.setTimer(timerKey({ kind: 'arp', address }), ARP_RETRY);
}

/**
 * Sends a packet to a neighbour on an Ethernet interface. With the neighbour's MAC unknown, the
 * packet waits while ARP asks for it, rather than being dropped as IOS would drop it.
 */
export function sendToNeighbour(
  ctx: IpContext,
  iface: EthernetInterface,
  address: Ipv4Address,
  packet: Ipv4Packet,
) {
  const { mac, port } = iface.medium;
  const known = cachedMac(ctx, address, port);
  if (known) {
    ctx.send(port, ethernet(mac, known, packet));
    return;
  }
  const pending = ctx.state.resolving.get(address);
  if (pending) {
    if (pending.waiting.length < WAITING_LIMIT) pending.waiting.push(packet);
    return;
  }
  ctx.state.resolving.set(address, { port, tries: 1, waiting: [packet] });
  request(ctx, iface, address);
}

/** A request went unanswered: ask again, or give up after the last try and drop what waited. */
export function onArpTimer(ctx: IpContext, address: Ipv4Address) {
  const pending = ctx.state.resolving.get(address);
  if (!pending) return;
  const iface = interfaceOn(interfacesOf(ctx), pending.port);
  if (!iface || !isEthernet(iface) || pending.tries >= ARP_TRIES) {
    ctx.state.resolving.delete(address);
    ctx.note(
      `ARP for ${address} went unanswered after ${pending.tries} tries; dropped ${pending.waiting.length} packet(s)`,
    );
    return;
  }
  pending.tries += 1;
  request(ctx, iface, address);
}

function learn(ctx: IpContext, iface: EthernetInterface, address: Ipv4Address, mac: MacAddress) {
  const { port } = iface.medium;
  ctx.state.arp.set(address, { mac, port, learnedAt: ctx.now });
  const pending = ctx.state.resolving.get(address);
  if (pending?.port !== port) return;
  ctx.state.resolving.delete(address);
  ctx.clearTimer(timerKey({ kind: 'arp', address }));
  for (const packet of pending.waiting) ctx.send(port, ethernet(iface.medium.mac, mac, packet));
}

/** IOS answers for an address it routes out another interface (`ip proxy-arp`, on by default). */
function proxies(ctx: IpContext, iface: EthernetInterface, target: Ipv4Address): boolean {
  if (ctx.device.kind !== 'router' || inPrefix(iface.cidr, target)) return false;
  const { interfaces, routes } = routesOf(ctx);
  const hop = nextHop(routes, interfaces, target);
  return hop !== undefined && hop.interface.name !== iface.name;
}

/**
 * An ARP packet arrived. The sender is learned when the packet is for this device or the sender
 * is already known (RFC 826), and a request for one of its addresses gets a reply.
 */
export function onArp(ctx: IpContext, iface: EthernetInterface, arp: ArpPacket) {
  const forUs = arp.targetIp === iface.cidr.address;
  if (forUs || ctx.state.arp.has(arp.senderIp)) learn(ctx, iface, arp.senderIp, arp.senderMac);
  if (arp.op !== 'request' || !(forUs || proxies(ctx, iface, arp.targetIp))) return;
  const { mac, port } = iface.medium;
  const reply: ArpPacket = {
    kind: 'arp',
    op: 'reply',
    senderMac: mac,
    senderIp: arp.targetIp,
    targetMac: arp.senderMac,
    targetIp: arp.senderIp,
  };
  ctx.send(port, ethernet(mac, arp.senderMac, reply));
}

/** A port went down: what was learned on it, and what waited to go out of it, is gone. */
export function forgetPort(ctx: IpContext, port: PortId) {
  const { arp, resolving } = ctx.state;
  for (const [address, entry] of arp) if (entry.port === port) arp.delete(address);
  for (const [address, pending] of resolving) {
    if (pending.port !== port) continue;
    resolving.delete(address);
    ctx.clearTimer(timerKey({ kind: 'arp', address }));
  }
}

/** The device's own Ethernet addresses and what it has learned, by address, for `show arp`. */
export function arpTable(ctx: IpContext): ArpTableEntry[] {
  const own = interfacesOf(ctx)
    .filter(isEthernet)
    .map(({ cidr, medium }): ArpTableEntry => ({
      kind: 'interface',
      address: cidr.address,
      mac: medium.mac,
      port: medium.port,
    }));
  const timeout = ARP_TIMEOUT[ctx.device.kind];
  const learned = [...ctx.state.arp].flatMap(
    ([address, { mac, port, learnedAt }]): ArpTableEntry[] => {
      const ageMs = ctx.now - learnedAt;
      return ageMs < timeout ? [{ kind: 'dynamic', address, mac, port, ageMs }] : [];
    },
  );
  return [...own, ...learned].sort((a, b) => compareAddresses(a.address, b.address));
}
