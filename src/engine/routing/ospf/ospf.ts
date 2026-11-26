import type { Ipv4Address, MacAddress } from '@/model';
import { ms } from '../../core/time';
import { inPrefix } from '../../l3/ipv4';
import { ADMINISTRATIVE_DISTANCE, type LearnedRoute } from '../../l3/routes';
import type { SimModule } from '../../module';
import { ALL_D_ROUTERS, ALL_SPF_ROUTERS, type OspfPacket } from '../../pdu';
import { arrival, packetIn } from '../link';
import { dropNeighbor, electDr, endWait, onDbd, onHello } from './adjacency';
import { LS_REFRESH_TIME, seconds, type OspfContext } from './context';
import { originate, runSpf } from './database';
import { onAck, onRequest, onUpdate, retransmit } from './flooding';
import { reconcile } from './process';
import { sendHello } from './send';
import { parseTimer, timerKey, type Iface, type OspfState, type Process } from './state';

/**
 * Single-area OSPFv2 as IOS runs it, by RFC 2328. Routers find neighbours with hellos, elect a DR
 * and BDR on each multi-access network, and bring adjacencies up to FULL by trading database
 * descriptions, requesting what they lack and flooding what changes, every LSA acknowledged.
 * Each router describes its links in a router LSA, each DR its network in a network LSA, and
 * every router runs Dijkstra over the same database to find its routes.
 */

function onTimer(ctx: OspfContext, key: string) {
  const timer = parseTimer(key);
  if (!timer) return;
  if (timer.kind === 'start') {
    reconcile(ctx);
    return;
  }
  const { process } = ctx.state;
  if (!process) return;
  switch (timer.kind) {
    case 'spf':
      runSpf(ctx, process);
      return;
    case 'refresh':
      originate(ctx, process, true);
      ctx.setTimer(timerKey({ kind: 'refresh' }), seconds(LS_REFRESH_TIME));
      return;
    case 'hello': {
      const iface = process.interfaces.get(timer.iface);
      if (iface && !iface.passive && iface.type !== 'loopback') sendHello(ctx, process, iface);
      return;
    }
    case 'wait': {
      const iface = process.interfaces.get(timer.iface);
      if (iface?.state !== 'waiting') return;
      endWait(ctx, process, iface);
      originate(ctx, process);
      return;
    }
    case 'dead': {
      const iface = process.interfaces.get(timer.iface);
      const neighbor = iface?.neighbors.get(timer.neighbor);
      if (!iface || !neighbor) return;
      dropNeighbor(ctx, process, iface, neighbor, 'Dead timer expired');
      electDr(ctx, process, iface);
      originate(ctx, process);
      return;
    }
    case 'rxmt': {
      const iface = process.interfaces.get(timer.iface);
      const neighbor = iface?.neighbors.get(timer.neighbor);
      if (iface && neighbor) retransmit(ctx, process, iface, neighbor);
      return;
    }
  }
}

function onPacket(
  ctx: OspfContext,
  process: Process,
  iface: Iface,
  src: Ipv4Address,
  dst: Ipv4Address,
  packet: OspfPacket,
  mac: MacAddress | undefined,
) {
  if (iface.passive || iface.type === 'loopback') return;
  // Only the DR and BDR listen to AllDRouters.
  if (dst === ALL_D_ROUTERS && iface.state !== 'dr' && iface.state !== 'backup') return;
  if (packet.routerId === process.routerId || !inPrefix(iface.ip.cidr, src)) return;
  if (packet.area !== iface.area) {
    ctx.note(
      `OSPF: ${packet.type} from ${packet.routerId} on ${iface.name} is for area ${packet.area}, not ${iface.area}`,
    );
    return;
  }
  if (packet.type === 'hello') {
    onHello(ctx, process, iface, packet, src, mac);
    return;
  }
  const neighbor = iface.neighbors.get(packet.routerId);
  if (!neighbor) return;
  switch (packet.type) {
    case 'dbd':
      onDbd(ctx, process, iface, neighbor, packet);
      return;
    case 'lsr':
      onRequest(ctx, process, iface, neighbor, packet);
      return;
    case 'lsu':
      onUpdate(ctx, process, iface, neighbor, packet);
      return;
    case 'lsack':
      onAck(neighbor, packet);
      return;
  }
}

/** OSPF on a router. The engine starts it on every router; it idles until `router ospf`. */
export const ospfModule: SimModule<OspfState> = {
  id: 'ospf',
  init(ctx) {
    ctx.setTimer(timerKey({ kind: 'start' }), ms(0));
    return { process: undefined, nextPacketId: 1 };
  },
  onFrame(ctx, port, frame) {
    const { process } = ctx.state;
    if (!process || packetIn(frame)?.payload.kind !== 'ospf') return;
    const interfaces = [...process.interfaces.values()].map((iface) => iface.ip);
    const arrived = arrival(ctx, interfaces, port, frame, [ALL_SPF_ROUTERS, ALL_D_ROUTERS]);
    const iface = arrived && process.interfaces.get(arrived.iface.name);
    if (!arrived || !iface || arrived.packet.payload.kind !== 'ospf') return;
    const { src, dst, payload } = arrived.packet;
    onPacket(ctx, process, iface, src, dst, payload, arrived.mac);
  },
  onTimer,
  onLinkChange: reconcile,
  onConfigChange: reconcile,
  routes(ctx): LearnedRoute[] {
    const { process } = ctx.state;
    if (!process) return [];
    return [...process.routes.values()].flatMap((route) =>
      route.hops.map((hop) => ({
        source: 'ospf' as const,
        prefix: route.prefix,
        distance: ADMINISTRATIVE_DISTANCE.ospf,
        metric: route.cost,
        via: hop.via,
        interface: hop.interface,
        ageMs: ctx.now - route.since,
      })),
    );
  },
};
