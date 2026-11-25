import type { SimModule } from '../module';
import { BROADCAST_MAC, type Ipv4Packet } from '../pdu';
import { forgetPort, onArp, onArpTimer } from './arp';
import { interfacesOf, parseTimer, routesOf, type IpContext, type IpState } from './context';
import { interfaceOn, isEthernet, ownsAddress } from './interfaces';
import { originate, reportError, transmit } from './output';
import { endPings, onPingAnswer, onPingTimer } from './ping';
import { nextHop } from './routes';

function deliver(ctx: IpContext, packet: Ipv4Packet) {
  const message = packet.payload;
  if (message.type === 'echo-request') {
    const reply = { kind: 'icmp', type: 'echo-reply', id: message.id, seq: message.seq } as const;
    originate(ctx, packet.src, reply, packet.dst);
  } else {
    onPingAnswer(ctx, packet, message);
  }
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
 * IPv4 on a router or an end host: ARP, forwarding, ICMP and ping in one module, since every
 * part reads the same ARP cache and the module boundary keeps state private. The device's
 * interfaces and routing table are derived from its config and link state on each use, so a
 * config edit or a link change takes effect on the next packet with nothing to invalidate.
 */
export const ipModule: SimModule<IpState> = {
  id: 'ipv4',
  init: () => ({
    arp: new Map(),
    resolving: new Map(),
    pings: new Map(),
    loopback: [],
    nextPacketId: 1,
    nextPingId: 1,
  }),
  onFrame(ctx, port, frame) {
    const iface = interfaceOn(interfacesOf(ctx), port);
    if (!iface) return;
    switch (frame.kind) {
      case 'hdlc':
        if (iface.medium.kind === 'serial') receive(ctx, frame.payload);
        return;
      case 'ethernet': {
        // A routed port takes untagged frames for its own MAC or broadcast. Subinterfaces for
        // router-on-a-stick are NOV-212.
        if (!isEthernet(iface) || frame.tag) return;
        if (frame.dst !== iface.medium.mac && frame.dst !== BROADCAST_MAC) return;
        if (frame.payload.kind === 'arp') onArp(ctx, iface, frame.payload);
        else receive(ctx, frame.payload);
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
      case 'ping':
        onPingTimer(ctx, timer.id);
        return;
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
  onStop: endPings,
};
