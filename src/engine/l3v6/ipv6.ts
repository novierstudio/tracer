import type { PortId } from '@/model';
import { isIpv6Multicast, isIpv6MulticastMac, isLinkLocal } from '@/model/ipv6';
import { ms } from '../core/time';
import type { SimModule } from '../module';
import type { EthernetFrame } from '../pdu';
import { NDP_HOP_LIMIT, type Ipv6Packet } from '../pdu6';
import {
  forgetAutoconfig,
  onAdvertiseTimer,
  onRouterAdvertisement,
  onRouterSolicitation,
  onSolicitTimer,
  reconcileAdvertising,
  startSoliciting,
} from './autoconfig';
import {
  groupsOf,
  lanInterfaceOn,
  ownsAddress6,
  routesIpv6,
  serialOn6,
  type Ipv6Interface,
  type LanInterface6,
} from './interfaces';
import { forgetPort6, neighborTable, onAdvertisement, onNdTimer, onSolicitation } from './nd';
import { interfacesOf6, originate6, reportError6, routesOf6, transmit6 } from './output';
import { matchAnswer6, onProbeAnswer6, onProbeTimer6, stopProbe6 } from './probes';
import { nextHop6 } from './routes';
import { emptyIpv6State, parseTimer, timerKey, type Ipv6Context, type Ipv6State } from './state';
import type { Ipv6Status } from './status';

export { startPing6, startTrace6, stopProbe6 } from './probes';
export type { Ipv6Context, Ipv6State } from './state';

/** A packet for this device, by what it carries. */
function deliver(ctx: Ipv6Context, packet: Ipv6Packet) {
  const message = packet.payload;
  if (message.type === 'echo-request') {
    const reply = { kind: 'icmpv6', type: 'echo-reply', id: message.id, seq: message.seq } as const;
    // An echo to a group is answered from the address the interface would use, not the group.
    originate6(ctx, packet.src, reply, isIpv6Multicast(packet.dst) ? {} : { src: packet.dst });
    return;
  }
  const answered = matchAnswer6(ctx, packet);
  if (answered) onProbeAnswer6(ctx, answered.probe, answered.answer);
}

/** Neighbor Discovery on a LAN. Any NDP message whose hop limit is not 255 crossed a router: dropped. */
function onNdp(ctx: Ipv6Context, iface: LanInterface6, port: PortId, packet: Ipv6Packet) {
  const message = packet.payload;
  if (packet.hopLimit !== NDP_HOP_LIMIT) return false;
  switch (message.type) {
    case 'neighbor-solicitation':
      onSolicitation(ctx, iface, port, packet, message);
      return true;
    case 'neighbor-advertisement':
      onAdvertisement(ctx, iface, port, message);
      return true;
    case 'router-solicitation':
      onRouterSolicitation(ctx, iface, port, packet, message);
      return true;
    case 'router-advertisement':
      onRouterAdvertisement(ctx, iface, port, packet, message);
      return true;
    default:
      return false;
  }
}

/**
 * A packet arrived on a working interface. One for this device, or for a group it joined there,
 * is delivered. A router with `ipv6 unicast-routing` forwards the rest with the hop limit
 * decremented, or tells the sender why it cannot. Anything else drops them.
 */
function receive(ctx: Ipv6Context, packet: Ipv6Packet, arrival: Ipv6Interface) {
  const { interfaces, routes } = routesOf6(ctx);
  const routing = routesIpv6(ctx.device);
  if (isIpv6Multicast(packet.dst)) {
    if (groupsOf(arrival, routing).includes(packet.dst)) deliver(ctx, packet);
    return;
  }
  if (ownsAddress6(interfaces, packet.dst)) {
    deliver(ctx, packet);
    return;
  }
  // Link-local packets never leave their link.
  if (!routing || isLinkLocal(packet.dst) || isLinkLocal(packet.src)) return;
  if (packet.hopLimit <= 1) {
    ctx.note(`Dropped a packet for ${packet.dst} from ${packet.src}: hop limit expired`);
    reportError6(ctx, { kind: 'icmpv6', type: 'time-exceeded', original: packet });
    return;
  }
  const hop = nextHop6(routes, interfaces, packet.dst);
  if (!hop) {
    ctx.note(`Dropped a packet for ${packet.dst} from ${packet.src}: no route`);
    reportError6(ctx, {
      kind: 'icmpv6',
      type: 'destination-unreachable',
      code: 'no-route',
      original: packet,
    });
    return;
  }
  transmit6(ctx, hop, { ...packet, hopLimit: packet.hopLimit - 1 }, true);
}

/**
 * Whether an Ethernet frame is for the interface: its own MAC, or a 33:33 group MAC of a group
 * the interface joined.
 */
function forInterface(ctx: Ipv6Context, iface: LanInterface6, frame: EthernetFrame) {
  if (frame.dst === iface.medium.mac) return true;
  if (!isIpv6MulticastMac(frame.dst) || frame.payload.kind !== 'ipv6') return false;
  return groupsOf(iface, routesIpv6(ctx.device)).includes(frame.payload.dst);
}

/** Every port's link, for the show commands. */
const portStates = (ctx: Ipv6Context) =>
  Object.fromEntries(ctx.device.ports.map((port) => [port.id, ctx.portUp(port.id)]));

/** What starts and stops with config and links: solicitations, advertisements, SLAAC. */
function reconcile(ctx: Ipv6Context) {
  forgetAutoconfig(ctx);
  startSoliciting(ctx);
  reconcileAdvertising(ctx);
}

/** The device's IPv6 as it runs now, for the show commands and `ipv6config`. */
export function ipv6Status(ctx: Ipv6Context): Ipv6Status {
  const { interfaces, routes } = routesOf6(ctx);
  const routing = routesIpv6(ctx.device);
  const host = ctx.device.kind === 'pc' || ctx.device.kind === 'server';
  const ipv6 = host ? ctx.device.config.ipv6 : undefined;
  const gateway =
    ipv6?.mode === 'static' ? ipv6.gateway : host ? ctx.state.defaultRouter?.address : undefined;
  return {
    routing,
    interfaces: interfaces.map((iface) => ({
      name: iface.name,
      up: iface.up,
      linkLocal: iface.linkLocal,
      addresses: iface.addresses,
      groups: groupsOf(iface, routing),
    })),
    routes,
    neighbors: neighborTable(ctx),
    ...(gateway && { gateway }),
    ports: portStates(ctx),
  };
}

/**
 * IPv6 on a router or an end host, beside IPv4 and sharing nothing with it: addresses (manual,
 * EUI-64, link-local and SLAAC), Neighbor Discovery with its neighbour cache, router
 * solicitations and advertisements, forwarding with static routes, ICMPv6 errors, ping and
 * traceroute. Interfaces and routes derive from config, links and SLAAC state on each use.
 */
export const ipv6Module: SimModule<Ipv6State> = {
  id: 'ipv6',
  init: (ctx) => {
    // Solicit and advertise once the device is up, as booting does.
    ctx.setTimer(timerKey({ kind: 'boot' }), ms(0));
    return emptyIpv6State();
  },
  onFrame(ctx, port, frame) {
    const interfaces = interfacesOf6(ctx);
    if (frame.kind === 'hdlc') {
      const iface = serialOn6(interfaces, port);
      if (iface && frame.payload.kind === 'ipv6') receive(ctx, frame.payload, iface);
      return;
    }
    if (frame.kind !== 'ethernet' || frame.payload.kind !== 'ipv6') return;
    const iface = lanInterfaceOn(interfaces, port, frame);
    if (!iface || !forInterface(ctx, iface, frame)) return;
    const packet = frame.payload;
    if (onNdp(ctx, iface, port, packet)) return;
    receive(ctx, packet, iface);
  },
  onTimer(ctx, key) {
    const timer = parseTimer(key);
    switch (timer?.kind) {
      case 'boot':
        reconcile(ctx);
        return;
      case 'nd': {
        const iface = interfacesOf6(ctx).find((candidate) => candidate.name === timer.interface);
        for (const packet of onNdTimer(ctx, iface, timer.address)) {
          reportError6(ctx, {
            kind: 'icmpv6',
            type: 'destination-unreachable',
            code: 'address-unreachable',
            original: packet,
          });
        }
        return;
      }
      case 'probe': {
        const probe = ctx.state.probes.get(timer.id);
        if (probe) onProbeTimer6(ctx, probe);
        return;
      }
      case 'loopback':
        for (const packet of ctx.state.loopback.splice(0)) deliver(ctx, packet);
        return;
      case 'ra':
        onAdvertiseTimer(ctx);
        return;
      case 'rs':
        onSolicitTimer(ctx, timer.interface);
        return;
      case undefined:
        return;
    }
  },
  onLinkChange(ctx, port) {
    const working = new Set(
      interfacesOf6(ctx)
        .filter((iface) => iface.up)
        .map((iface) => iface.name as string),
    );
    if (!ctx.portUp(port)) forgetPort6(ctx, port, working);
    // A link that comes up is a new link: advertise and solicit on it from the start.
    ctx.state.advertised = undefined;
    reconcile(ctx);
  },
  onConfigChange(ctx) {
    reconcile(ctx);
  },
  onStop(ctx) {
    for (const id of [...ctx.state.probes.keys()]) stopProbe6(ctx, id);
  },
};
