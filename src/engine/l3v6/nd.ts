import type { MacAddress, PortId } from '@/model';
import {
  ALL_NODES,
  compareIpv6,
  inIpv6Prefix,
  ipv6MulticastMac,
  isIpv6Multicast,
  isLinkLocal,
  solicitedNode,
  UNSPECIFIED_IPV6,
  type Ipv6Address,
} from '@/model/ipv6';
import { ms } from '../core/time';
import {
  NDP_HOP_LIMIT,
  type Ipv6Packet,
  type NeighborAdvertisement,
  type NeighborSolicitation,
} from '../pdu6';
import {
  addressesOf,
  routesIpv6,
  sendOn,
  type Ipv6Interface,
  type LanInterface6,
} from './interfaces';
import { neighborKey, timerKey, type Ipv6Context, type Waiting } from './state';
import type { Ipv6NeighborEntry } from './status';

/** A solicitation unanswered for this long is sent again, up to MAX_SOLICIT in all (RFC 4861). */
export const RETRANS_TIMER = ms(1000);
export const MAX_SOLICIT = 3;

/** A neighbour confirmed within this long is REACH; after it, STALE, as IOS shows. */
export const REACHABLE_TIME = ms(30_000);

/** Packets held per next hop while it resolves. Past this, new ones are dropped. */
const WAITING_LIMIT = 16;

/**
 * The address an interface sends from to `dst`: a global address in the same prefix, else its
 * first global address for a global destination, else its link-local address.
 */
export function sourceFor(iface: Ipv6Interface, dst: Ipv6Address): Ipv6Address {
  const global = !isIpv6Multicast(dst) && !isLinkLocal(dst);
  const same = iface.addresses.find((entry) => inIpv6Prefix(entry, dst));
  if (same) return same.address;
  const [first] = iface.addresses;
  return global && first ? first.address : iface.linkLocal;
}

function solicit(ctx: Ipv6Context, iface: LanInterface6, target: Ipv6Address) {
  const group = solicitedNode(target);
  const ns: NeighborSolicitation = {
    kind: 'icmpv6',
    type: 'neighbor-solicitation',
    target,
    sourceMac: iface.medium.mac,
  };
  const packet: Ipv6Packet = {
    kind: 'ipv6',
    src: sourceFor(iface, target),
    dst: group,
    hopLimit: NDP_HOP_LIMIT,
    payload: ns,
  };
  sendOn(ctx, iface, packet, ipv6MulticastMac(group));
  ctx.setTimer(timerKey({ kind: 'nd', interface: iface.name, address: target }), RETRANS_TIMER);
}

/**
 * Sends a packet to a neighbour on a LAN interface. A multicast goes to its group's MAC. With the
 * neighbour's MAC unknown, the packet waits while a neighbor solicitation asks for it.
 */
export function sendToNeighbor6(
  ctx: Ipv6Context,
  iface: LanInterface6,
  address: Ipv6Address,
  waiting: Waiting,
) {
  if (isIpv6Multicast(address)) {
    sendOn(ctx, iface, waiting.packet, ipv6MulticastMac(address));
    return;
  }
  const key = neighborKey(iface.name, address);
  const known = ctx.state.neighbors.get(key);
  if (known) {
    sendOn(ctx, iface, waiting.packet, known.mac);
    return;
  }
  const pending = ctx.state.resolving.get(key);
  if (pending) {
    if (pending.waiting.length < WAITING_LIMIT) pending.waiting.push(waiting);
    return;
  }
  ctx.state.resolving.set(key, { interface: iface.name, address, tries: 1, waiting: [waiting] });
  solicit(ctx, iface, address);
}

/**
 * A solicitation went unanswered: ask again, or give up after the last try. Returns the packets
 * this device forwarded that it then dropped, whose senders should hear Address Unreachable.
 */
export function onNdTimer(
  ctx: Ipv6Context,
  iface: Ipv6Interface | undefined,
  address: Ipv6Address,
): Ipv6Packet[] {
  if (!iface) return [];
  const key = neighborKey(iface.name, address);
  const pending = ctx.state.resolving.get(key);
  if (!pending) return [];
  if (iface.up && iface.medium.kind === 'ethernet' && pending.tries < MAX_SOLICIT) {
    pending.tries += 1;
    solicit(ctx, iface as LanInterface6, address);
    return [];
  }
  ctx.state.resolving.delete(key);
  ctx.note(
    `Neighbor discovery for ${address} went unanswered after ${pending.tries} tries; dropped ${pending.waiting.length} packet(s)`,
  );
  return pending.waiting.filter((held) => held.forwarded).map((held) => held.packet);
}

/** Records that `address` is at `mac` on the interface, and sends what waited for it. */
export function learnNeighbor(
  ctx: Ipv6Context,
  iface: LanInterface6,
  port: PortId,
  address: Ipv6Address,
  mac: MacAddress,
  router: boolean,
) {
  const key = neighborKey(iface.name, address);
  const known = ctx.state.neighbors.get(key);
  ctx.state.neighbors.set(key, {
    address,
    interface: iface.name,
    mac,
    port,
    confirmedAt: ctx.now,
    router: router || (known?.router ?? false),
  });
  const pending = ctx.state.resolving.get(key);
  if (!pending) return;
  ctx.state.resolving.delete(key);
  ctx.clearTimer(timerKey({ kind: 'nd', interface: iface.name, address }));
  for (const held of pending.waiting) sendOn(ctx, iface, held.packet, mac);
}

/**
 * A neighbor solicitation arrived. The sender is learned from its link-layer option, and one for
 * an address of this interface is answered with an advertisement straight back to the sender.
 * A solicitation from the unspecified address, a duplicate address check, is answered to all nodes.
 */
export function onSolicitation(
  ctx: Ipv6Context,
  iface: LanInterface6,
  port: PortId,
  packet: Ipv6Packet,
  ns: NeighborSolicitation,
) {
  const fromNobody = packet.src === UNSPECIFIED_IPV6;
  if (!fromNobody && ns.sourceMac) learnNeighbor(ctx, iface, port, packet.src, ns.sourceMac, false);
  if (!addressesOf(iface).includes(ns.target)) return;
  const na: NeighborAdvertisement = {
    kind: 'icmpv6',
    type: 'neighbor-advertisement',
    target: ns.target,
    router: routesIpv6(ctx.device),
    solicited: !fromNobody,
    override: true,
    targetMac: iface.medium.mac,
  };
  const dst = fromNobody ? ALL_NODES : packet.src;
  const reply: Ipv6Packet = {
    kind: 'ipv6',
    src: ns.target,
    dst,
    hopLimit: NDP_HOP_LIMIT,
    payload: na,
  };
  const mac = fromNobody
    ? ipv6MulticastMac(ALL_NODES)
    : (ns.sourceMac ?? ctx.state.neighbors.get(neighborKey(iface.name, packet.src))?.mac);
  sendOn(ctx, iface, reply, mac);
}

/**
 * A neighbor advertisement arrived. It updates a neighbour this device knows or is resolving, as
 * RFC 4861 says; an advertisement nobody asked about creates no entry.
 */
export function onAdvertisement(
  ctx: Ipv6Context,
  iface: LanInterface6,
  port: PortId,
  na: NeighborAdvertisement,
) {
  const key = neighborKey(iface.name, na.target);
  if (!ctx.state.neighbors.has(key) && !ctx.state.resolving.has(key)) return;
  learnNeighbor(ctx, iface, port, na.target, na.targetMac, na.router);
}

/**
 * A port went down: what was learned on it is gone, and so is what waited to go out of an
 * interface that went down with it.
 */
export function forgetPort6(ctx: Ipv6Context, port: PortId, working: ReadonlySet<string>) {
  const { neighbors, resolving } = ctx.state;
  for (const [key, entry] of neighbors) if (entry.port === port) neighbors.delete(key);
  for (const [key, pending] of resolving) {
    if (working.has(pending.interface)) continue;
    resolving.delete(key);
    ctx.clearTimer(
      timerKey({ kind: 'nd', interface: pending.interface, address: pending.address }),
    );
  }
}

/** The neighbour cache, by address, for `show ipv6 neighbors`. */
export function neighborTable(ctx: Ipv6Context): Ipv6NeighborEntry[] {
  return [...ctx.state.neighbors.values()]
    .map(({ address, mac, interface: name, confirmedAt, router }): Ipv6NeighborEntry => {
      const ageMs = ctx.now - confirmedAt;
      return {
        address,
        mac,
        interface: name,
        ageMs,
        state: ageMs < REACHABLE_TIME ? 'REACH' : 'STALE',
        router,
      };
    })
    .sort((a, b) => compareIpv6(a.address, b.address) || a.interface.localeCompare(b.interface));
}
