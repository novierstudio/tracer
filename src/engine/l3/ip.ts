import type { SimModule } from '../module';
import { BROADCAST_MAC, isMulticast, LIMITED_BROADCAST, type Ipv4Packet } from '../pdu';
import { deniedBy, forgetRemovedLists, type Direction } from './acl';
import { forgetPort, onArp, onArpTimer } from './arp';
import {
  interfacesOf,
  parseTimer,
  routesOf,
  type IpContext,
  type IpState,
  type Probe,
} from './context';
import {
  abandonDhcp,
  bootDhcp,
  DHCP_STOPPED,
  onDhcpTimer,
  reconcileDhcp,
  takeDhcpReply,
} from './dhcpClient';
import { onDnsTimer, stopLookups } from './dnsResolver';
import { matchAnswer, type EchoAnswer } from './echo';
import { stopFetches } from './httpClient';
import {
  lanInterfaceFor,
  ownsAddress,
  routesPackets,
  serialOn,
  type IpInterface,
} from './interfaces';
import { emptyNatTable, natIn, natOut } from './nat';
import { originate, reportError, transmit } from './output';
import { finishPing, onPingAnswer, onPingTimer } from './ping';
import { nextHop } from './routes';
import { onTcpSegment, onTcpTimer } from './tcpStack';
import { finishTrace, onTraceAnswer } from './traceroute';
import { emptyTransport } from './transport';
import { deliverUdp } from './udp';

function onProbeAnswer(ctx: IpContext, probe: Probe, answer: EchoAnswer) {
  if (probe.kind === 'ping') onPingAnswer(ctx, probe, answer);
  else onTraceAnswer(ctx, probe, answer);
}

/**
 * Ends the ping or traceroute `id`, if it still runs: no more requests go out, and its listener
 * hears a summary of what came back so far.
 */
export function stopProbe(ctx: IpContext, id: number) {
  const probe = ctx.state.probes.get(id);
  if (probe?.kind === 'ping') finishPing(ctx, probe);
  else if (probe?.kind === 'trace') finishTrace(ctx, probe);
}

/** A packet for this device, by what it carries. `arrival` is absent for one it sent itself. */
function deliver(ctx: IpContext, packet: Ipv4Packet, arrival?: IpInterface) {
  const message = packet.payload;
  if (message.kind === 'udp') {
    deliverUdp(ctx, packet, message, arrival);
    return;
  }
  if (message.kind === 'tcp') {
    onTcpSegment(ctx, packet, message);
    return;
  }
  // OSPF runs in a module of its own, which reads its packets from the frames it sees.
  if (message.kind === 'ospf') return;
  if (message.type === 'echo-request') {
    const reply = { kind: 'icmp', type: 'echo-reply', id: message.id, seq: message.seq } as const;
    originate(ctx, packet.src, reply, { src: packet.dst });
    return;
  }
  const answered = matchAnswer(ctx, packet, message);
  if (answered) onProbeAnswer(ctx, answered.probe, answered.answer);
}

/**
 * Whether the interface's access list in `direction` drops the packet. Its sender hears
 * Destination Unreachable, administratively prohibited, about `original`: the packet as it
 * arrived, before NAT rewrote it.
 */
function filtered(
  ctx: IpContext,
  iface: IpInterface,
  direction: Direction,
  packet: Ipv4Packet,
  original = packet,
): boolean {
  const list = deniedBy(ctx, iface, direction, packet);
  if (list === undefined) return false;
  ctx.note(
    `Dropped a packet for ${packet.dst} from ${packet.src}: access list ${list} denied it ${direction} on ${iface.name}`,
  );
  reportError(ctx, {
    kind: 'icmp',
    type: 'destination-unreachable',
    code: 'admin-prohibited',
    original,
  });
  return true;
}

/**
 * A packet arrived on a working interface. One for this device, or for every host on the
 * network, is delivered. A router, or a switch with `ip routing`, forwards the rest with the TTL
 * decremented, or tells the sender why it cannot. A host or a layer 2 switch drops them. On the
 * way through, as on IOS: the arrival interface's inbound access list, NAT from outside to
 * inside, routing, NAT from inside to outside, then the exit interface's outbound access list.
 */
function receive(ctx: IpContext, arrived: Ipv4Packet, arrival: IpInterface) {
  if (filtered(ctx, arrival, 'in', arrived)) return;
  const packet = natIn(ctx, arrived, arrival);
  const { interfaces, routes } = routesOf(ctx);
  if (packet.dst === LIMITED_BROADCAST || ownsAddress(interfaces, packet.dst)) {
    deliver(ctx, packet, arrival);
    return;
  }
  if (!routesPackets(ctx.device)) return;
  // A router forwards unicast only. A multicast stays on its own link, where routing protocols,
  // which run in modules of their own, read it.
  if (isMulticast(packet.dst)) return;
  if (packet.ttl <= 1) {
    ctx.note(`Dropped a packet for ${packet.dst} from ${packet.src}: TTL expired`);
    reportError(ctx, { kind: 'icmp', type: 'time-exceeded', original: packet });
    return;
  }
  const hop = nextHop(routes, interfaces, packet.dst);
  if (!hop) {
    ctx.note(`Dropped a packet for ${packet.dst} from ${packet.src}: no route`);
    reportError(ctx, {
      kind: 'icmp',
      type: 'destination-unreachable',
      code: 'network',
      original: packet,
    });
    return;
  }
  const forwarded = natOut(ctx, { ...packet, ttl: packet.ttl - 1 }, arrival, hop.interface);
  if (!forwarded || filtered(ctx, hop.interface, 'out', forwarded, arrived)) return;
  transmit(ctx, hop, forwarded);
}

/**
 * IPv4 on a router or an end host: ARP, forwarding, ICMP, ping and traceroute in one module, since
 * every part reads the same ARP cache and the module boundary keeps state private. So do UDP and
 * DHCP: a host's DHCP lease is its address, and a router's DHCP server answers on its interfaces.
 * So do TCP, DNS and HTTP, which send through the same routes and ARP cache.
 * The device's interfaces and routing table are derived from its config, its lease and its link
 * state on each use, so a change takes effect on the next packet with nothing to invalidate.
 */
export const ipModule: SimModule<IpState> = {
  id: 'ipv4',
  init: (ctx) => {
    bootDhcp(ctx);
    return {
      arp: new Map(),
      resolving: new Map(),
      probes: new Map(),
      loopback: [],
      nextPacketId: 1,
      nextProbeId: 1,
      dhcp: DHCP_STOPPED,
      dhcpWaiters: [],
      bindings: new Map(),
      transport: emptyTransport(),
      aclHits: new Map(),
      nat: emptyNatTable(),
    };
  },
  onFrame(ctx, port, frame) {
    switch (frame.kind) {
      case 'hdlc': {
        const iface = serialOn(interfacesOf(ctx), port);
        // IPv6 runs in a module of its own.
        if (iface && frame.payload.kind === 'ipv4') receive(ctx, frame.payload, iface);
        return;
      }
      case 'ethernet': {
        if (takeDhcpReply(ctx, port, frame)) return;
        // A LAN interface takes frames of its VLAN for its own MAC or broadcast.
        const iface = lanInterfaceFor(ctx, interfacesOf(ctx), port, frame);
        if (!iface) return;
        if (frame.dst !== iface.medium.mac && frame.dst !== BROADCAST_MAC) return;
        if (frame.payload.kind === 'arp') onArp(ctx, iface, port, frame.payload);
        else if (frame.payload.kind === 'ipv4') receive(ctx, frame.payload, iface);
        return;
      }
      case 'hello':
        return;
    }
  },
  onTimer(ctx, key) {
    const timer = parseTimer(key);
    switch (timer?.kind) {
      case 'arp':
        onArpTimer(ctx, timer.address);
        return;
      case 'probe': {
        const probe = ctx.state.probes.get(timer.id);
        if (probe?.kind === 'ping') onPingTimer(ctx, probe);
        else if (probe) onProbeAnswer(ctx, probe, { kind: 'timeout' });
        return;
      }
      case 'loopback':
        for (const packet of ctx.state.loopback.splice(0)) deliver(ctx, packet);
        return;
      case 'dhcp':
        onDhcpTimer(ctx);
        return;
      case 'tcp':
        onTcpTimer(ctx, timer.id);
        return;
      case 'dns':
        onDnsTimer(ctx, timer.port);
        return;
      case undefined:
        return;
    }
  },
  onLinkChange(ctx, port, up) {
    if (!up) forgetPort(ctx, port);
    reconcileDhcp(ctx);
  },
  onConfigChange(ctx) {
    reconcileDhcp(ctx);
    forgetRemovedLists(ctx);
  },
  /**
   * The device is going away: every ping and traceroute it runs ends with what it got so far,
   * and whoever waits on its DHCP client hears that nothing came.
   */
  onStop(ctx) {
    for (const id of [...ctx.state.probes.keys()]) stopProbe(ctx, id);
    abandonDhcp(ctx);
    stopFetches(ctx);
    stopLookups(ctx);
  },
};
