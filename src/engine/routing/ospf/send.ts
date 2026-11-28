import type { SimTime } from '../../core/time';
import { compareAddresses } from '../../l3/ipv4';
import {
  ALL_D_ROUTERS,
  ALL_SPF_ROUTERS,
  type LsaHeader,
  type OspfDatabaseDescription,
  type OspfHello,
  type OspfLinkStateAck,
  type OspfLinkStateRequest,
  type OspfLinkStateUpdate,
  type OspfPacket,
} from '../../pdu';
import { sendOn } from '../link';
import { seconds, timersOf, type OspfContext } from './context';
import { timerKey, type Iface, type Neighbor, type Process } from './state';

/** What a packet says besides the header every OSPF packet carries. */
type Body =
  | Omit<OspfHello, 'kind' | 'routerId' | 'area'>
  | Omit<OspfDatabaseDescription, 'kind' | 'routerId' | 'area'>
  | Omit<OspfLinkStateRequest, 'kind' | 'routerId' | 'area'>
  | Omit<OspfLinkStateUpdate, 'kind' | 'routerId' | 'area'>
  | Omit<OspfLinkStateAck, 'kind' | 'routerId' | 'area'>;

/** Who a packet is for on its link: every OSPF router, the DR and BDR, or one neighbour. */
type Audience = 'all' | 'dr' | Neighbor;

const MTU = 1500;

/** OSPF packets never leave their link. */
const OSPF_TTL = 1;

export function send(ctx: OspfContext, process: Process, iface: Iface, body: Body, to: Audience) {
  const packet = {
    kind: 'ospf',
    routerId: process.routerId,
    area: iface.area,
    ...body,
  } as OspfPacket;
  // A point-to-point link has one neighbour, so everything goes to the group.
  const unicast = typeof to === 'object' && iface.type === 'broadcast' && to.mac !== undefined;
  const dst = unicast ? to.address : to === 'dr' ? ALL_D_ROUTERS : ALL_SPF_ROUTERS;
  sendOn(
    ctx,
    iface.ip,
    {
      kind: 'ipv4',
      src: iface.ip.cidr.address,
      dst,
      ttl: OSPF_TTL,
      id: ctx.state.nextPacketId++,
      payload: packet,
    },
    unicast ? to.mac : undefined,
  );
}

/** Where news goes on a link: from the DR or BDR to everyone, from anyone else to the DR and BDR. */
export const floodAudience = (iface: Iface): Audience =>
  iface.type === 'broadcast' && iface.state !== 'dr' && iface.state !== 'backup' ? 'dr' : 'all';

export function sendHello(ctx: OspfContext, process: Process, iface: Iface) {
  const { hello, dead } = timersOf(ctx);
  send(
    ctx,
    process,
    iface,
    {
      type: 'hello',
      networkMask: iface.ip.cidr.prefixLength,
      helloInterval: hello,
      deadInterval: dead,
      priority: iface.priority,
      stub: iface.stub,
      dr: iface.dr,
      bdr: iface.bdr,
      neighbors: [...iface.neighbors.keys()].sort(compareAddresses),
    },
    'all',
  );
  iface.helloAt = (ctx.now + seconds(hello)) as SimTime;
  ctx.setTimer(timerKey({ kind: 'hello', iface: iface.name }), seconds(hello));
}

export const armRetransmit = (ctx: OspfContext, iface: Iface, neighbor: Neighbor) =>
  ctx.setTimer(
    timerKey({ kind: 'rxmt', iface: iface.name, neighbor: neighbor.routerId }),
    seconds(timersOf(ctx).retransmit),
  );

export function sendDbd(
  ctx: OspfContext,
  process: Process,
  iface: Iface,
  neighbor: Neighbor,
  flags: Pick<OspfDatabaseDescription, 'init' | 'more' | 'master'>,
  headers: readonly LsaHeader[],
) {
  const body = { type: 'dbd', mtu: MTU, ...flags, sequence: neighbor.ddSequence, headers } as const;
  neighbor.lastDbd = { kind: 'ospf', routerId: process.routerId, area: iface.area, ...body };
  send(ctx, process, iface, body, neighbor);
  armRetransmit(ctx, iface, neighbor);
}

export function sendRequest(ctx: OspfContext, process: Process, iface: Iface, neighbor: Neighbor) {
  const requests = [...neighbor.requests.values()].map(({ type, id, advertisingRouter }) => ({
    type,
    id,
    advertisingRouter,
  }));
  send(ctx, process, iface, { type: 'lsr', requests }, neighbor);
  armRetransmit(ctx, iface, neighbor);
}
