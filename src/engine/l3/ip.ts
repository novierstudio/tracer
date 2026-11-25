import type { SimModule } from '../module';
import { BROADCAST_MAC, type Ipv4Packet } from '../pdu';
import { forgetPort, onArp, onArpTimer } from './arp';
import {
  interfacesOf,
  parseTimer,
  routesOf,
  type IpContext,
  type IpState,
  type Probe,
} from './context';
import { matchAnswer, type EchoAnswer } from './echo';
import { lanInterfaceFor, ownsAddress, serialOn } from './interfaces';
import { originate, reportError, transmit } from './output';
import { finishPing, onPingAnswer, onPingTimer } from './ping';
import { nextHop } from './routes';
import { finishTrace, onTraceAnswer } from './traceroute';

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

function deliver(ctx: IpContext, packet: Ipv4Packet) {
  const message = packet.payload;
  if (message.type === 'echo-request') {
    const reply = { kind: 'icmp', type: 'echo-reply', id: message.id, seq: message.seq } as const;
    originate(ctx, packet.src, reply, { src: packet.dst });
    return;
  }
  const answered = matchAnswer(ctx, packet, message);
  if (answered) onProbeAnswer(ctx, answered.probe, answered.answer);
}

/**
 * A packet arrived on a working interface. One for this device is delivered. A router forwards
 * the rest with the TTL decremented, or tells the sender why it cannot. A host drops them.
 */
function receive(ctx: IpContext, packet: Ipv4Packet) {
  const { interfaces, routes } = routesOf(ctx);
  if (ownsAddress(interfaces, packet.dst)) {
    deliver(ctx, packet);
    return;
  }
  if (ctx.device.kind !== 'router') return;
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
  transmit(ctx, hop, { ...packet, ttl: packet.ttl - 1 });
}

/**
 * IPv4 on a router or an end host: ARP, forwarding, ICMP, ping and traceroute in one module, since
 * every part reads the same ARP cache and the module boundary keeps state private. The device's
 * interfaces and routing table are derived from its config and link state on each use, so a
 * config edit or a link change takes effect on the next packet with nothing to invalidate.
 */
export const ipModule: SimModule<IpState> = {
  id: 'ipv4',
  init: () => ({
    arp: new Map(),
    resolving: new Map(),
    probes: new Map(),
    loopback: [],
    nextPacketId: 1,
    nextProbeId: 1,
  }),
  onFrame(ctx, port, frame) {
    switch (frame.kind) {
      case 'hdlc':
        if (serialOn(interfacesOf(ctx), port)) receive(ctx, frame.payload);
        return;
      case 'ethernet': {
        // A LAN interface takes frames of its VLAN for its own MAC or broadcast.
        const iface = lanInterfaceFor(ctx.device, interfacesOf(ctx), port, frame);
        if (!iface) return;
        if (frame.dst !== iface.medium.mac && frame.dst !== BROADCAST_MAC) return;
        if (frame.payload.kind === 'arp') onArp(ctx, iface, port, frame.payload);
        else if (frame.payload.kind === 'ipv4') receive(ctx, frame.payload);
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
      case undefined:
        return;
    }
  },
  onLinkChange(ctx, port, up) {
    if (!up) forgetPort(ctx, port);
  },
  /** The device is going away: every ping and traceroute it runs ends with what it got so far. */
  onStop(ctx) {
    for (const id of [...ctx.state.probes.keys()]) stopProbe(ctx, id);
  },
};
