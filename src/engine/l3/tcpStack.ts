import type { Ipv4Address } from '@/model';
import { ms } from '../core/time';
import { byteLength, httpText } from '../http';
import { LIMITED_BROADCAST, UNSPECIFIED_ADDRESS, type Ipv4Packet } from '../pdu';
import { TCP_WINDOW, type TcpFlags, type TcpPayload, type TcpSegment } from '../tcp';
import { routesOf, timerKey, type IpContext } from './context';
import { onFetchAborted, onFetchConnected, onFetchData } from './httpClient';
import { httpListening, onHttpRequest } from './httpServer';
import { ownsAddress } from './interfaces';
import { originate } from './output';
import { nextHop } from './routes';
import { ephemeralPort, random32, type TcpConnection, type TcpOwner } from './transport';

/** How long a connection waits to hear from its peer before it gives up. */
export const TCP_TIMEOUT = ms(5000);

/** Why a connection ended without a close: a reset to its SYN, a reset later, or silence. */
export type TcpAbort = 'refused' | 'reset' | 'timeout';

const NO_FLAGS: TcpFlags = { syn: false, ack: false, fin: false, rst: false, psh: false };

const flags = (...set: (keyof TcpFlags)[]): TcpFlags => {
  const out = { ...NO_FLAGS };
  for (const flag of set) out[flag] = true;
  return out;
};

/** Sequence numbers wrap at 2^32. */
const plus = (seq: number, count: number) => (seq + count) >>> 0;

const dataLength = (payload: TcpPayload | undefined) =>
  payload ? byteLength(httpText(payload)) : 0;

/** The sequence space a segment takes: its data, and one each for a SYN and a FIN. */
export const segmentLength = (segment: TcpSegment) =>
  dataLength(segment.payload) + (segment.flags.syn ? 1 : 0) + (segment.flags.fin ? 1 : 0);

/** Which application listens on a port of this device, if any. */
const listenerOn = (ctx: IpContext, port: number): TcpOwner | undefined =>
  httpListening(ctx, port) ? { kind: 'http-server' } : undefined;

const touch = (ctx: IpContext, connection: TcpConnection) =>
  ctx.setTimer(timerKey({ kind: 'tcp', id: connection.id }), TCP_TIMEOUT);

function forget(ctx: IpContext, connection: TcpConnection) {
  ctx.state.transport.connections.delete(connection.id);
  ctx.clearTimer(timerKey({ kind: 'tcp', id: connection.id }));
}

function send(ctx: IpContext, connection: TcpConnection, set: TcpFlags, payload?: TcpPayload) {
  const segment: TcpSegment = {
    kind: 'tcp',
    srcPort: connection.localPort,
    dstPort: connection.remotePort,
    seq: connection.sndNxt,
    ack: set.ack ? connection.rcvNxt : 0,
    flags: set,
    window: TCP_WINDOW,
    ...(payload && { payload }),
  };
  connection.sndNxt = plus(connection.sndNxt, segmentLength(segment));
  originate(ctx, connection.remote, segment, { src: connection.local });
}

function opened(ctx: IpContext, connection: TcpConnection) {
  if (connection.owner.kind === 'fetch') onFetchConnected(ctx, connection.owner.fetch, connection);
}

function received(ctx: IpContext, connection: TcpConnection, payload: TcpPayload) {
  if (connection.owner.kind === 'fetch')
    onFetchData(ctx, connection.owner.fetch, connection, payload);
  else onHttpRequest(ctx, connection, payload);
}

function aborted(ctx: IpContext, connection: TcpConnection, why: TcpAbort) {
  forget(ctx, connection);
  if (connection.owner.kind === 'fetch')
    onFetchAborted(ctx, connection.owner.fetch, connection, why);
}

/**
 * Opens a connection to `remote`'s `remotePort` from a random free port: sends the SYN and
 * returns the connection, whose owner hears when it opens. With no route the SYN goes nowhere
 * and the connection times out.
 */
export function tcpConnect(
  ctx: IpContext,
  remote: Ipv4Address,
  remotePort: number,
  owner: TcpOwner,
): TcpConnection {
  const { interfaces, routes } = routesOf(ctx);
  const local = ownsAddress(interfaces, remote)
    ? remote
    : (nextHop(routes, interfaces, remote)?.interface.cidr.address ?? UNSPECIFIED_ADDRESS);
  const { transport } = ctx.state;
  const connection: TcpConnection = {
    id: transport.nextId++,
    local,
    localPort: ephemeralPort(ctx),
    remote,
    remotePort,
    owner,
    state: 'syn-sent',
    sndNxt: random32(ctx),
    rcvNxt: 0,
  };
  transport.connections.set(connection.id, connection);
  touch(ctx, connection);
  send(ctx, connection, flags('syn'));
  return connection;
}

/** Sends one whole application message on an open connection. */
export function tcpSend(ctx: IpContext, connection: TcpConnection, payload: TcpPayload) {
  send(ctx, connection, flags('psh', 'ack'), payload);
}

/** Closes this side of the connection with a FIN. The other side may still send until it closes. */
export function tcpClose(ctx: IpContext, connection: TcpConnection) {
  if (connection.state === 'established') connection.state = 'fin-wait-1';
  else if (connection.state === 'close-wait') connection.state = 'last-ack';
  else return;
  send(ctx, connection, flags('fin', 'ack'));
}

/**
 * A segment for a port with no connection: a SYN opens one if something listens, anything else
 * but a reset is answered with one, as RFC 793 says a closed port does.
 */
function onClosedPort(ctx: IpContext, packet: Ipv4Packet, segment: TcpSegment) {
  if (segment.flags.rst) return;
  const owner = segment.flags.syn && !segment.flags.ack && listenerOn(ctx, segment.dstPort);
  if (owner) {
    const { transport } = ctx.state;
    const connection: TcpConnection = {
      id: transport.nextId++,
      local: packet.dst,
      localPort: segment.dstPort,
      remote: packet.src,
      remotePort: segment.srcPort,
      owner,
      state: 'syn-received',
      sndNxt: random32(ctx),
      rcvNxt: plus(segment.seq, 1),
    };
    transport.connections.set(connection.id, connection);
    touch(ctx, connection);
    send(ctx, connection, flags('syn', 'ack'));
    return;
  }
  if (segment.flags.syn) {
    ctx.note(
      `Refused a TCP connection to port ${segment.dstPort} from ${packet.src}: nothing listens there`,
    );
  }
  const reset = segment.flags.ack
    ? { seq: segment.ack, ack: 0, flags: flags('rst') }
    : { seq: 0, ack: plus(segment.seq, segmentLength(segment)), flags: flags('rst', 'ack') };
  const answer: TcpSegment = {
    kind: 'tcp',
    srcPort: segment.dstPort,
    dstPort: segment.srcPort,
    window: 0,
    ...reset,
  };
  originate(ctx, packet.src, answer, { src: packet.dst });
}

/**
 * A segment arrived for this device. Tracer never loses a segment in order and never retransmits,
 * so one that is not the next expected is dropped, and an acknowledgment counts only when it
 * covers everything sent. Received data and FINs are acknowledged by whatever the application
 * sends in answer, or else by a bare ACK.
 */
export function onTcpSegment(ctx: IpContext, packet: Ipv4Packet, segment: TcpSegment) {
  if (packet.dst === LIMITED_BROADCAST) return;
  const connection = [...ctx.state.transport.connections.values()].find(
    (candidate) =>
      candidate.local === packet.dst &&
      candidate.localPort === segment.dstPort &&
      candidate.remote === packet.src &&
      candidate.remotePort === segment.srcPort,
  );
  if (!connection) {
    onClosedPort(ctx, packet, segment);
    return;
  }
  if (segment.flags.rst) {
    aborted(ctx, connection, connection.state === 'syn-sent' ? 'refused' : 'reset');
    return;
  }
  if (connection.state === 'syn-sent') {
    const { syn, ack } = segment.flags;
    if (!syn || !ack || segment.ack !== connection.sndNxt) return;
    connection.rcvNxt = plus(segment.seq, 1);
    connection.state = 'established';
    touch(ctx, connection);
    send(ctx, connection, flags('ack'));
    opened(ctx, connection);
    return;
  }
  if (segment.seq !== connection.rcvNxt) return;
  touch(ctx, connection);

  if (segment.flags.ack && segment.ack === connection.sndNxt) {
    switch (connection.state) {
      case 'syn-received':
        connection.state = 'established';
        break;
      case 'fin-wait-1':
        connection.state = 'fin-wait-2';
        break;
      case 'closing':
      case 'last-ack':
        forget(ctx, connection);
        return;
      default:
        break;
    }
  }

  const sentBefore = connection.sndNxt;
  let owed = false;
  const reading =
    connection.state === 'established' ||
    connection.state === 'fin-wait-1' ||
    connection.state === 'fin-wait-2';
  if (segment.payload && reading) {
    connection.rcvNxt = plus(connection.rcvNxt, dataLength(segment.payload));
    owed = true;
    received(ctx, connection, segment.payload);
  }
  let closed = false;
  if (segment.flags.fin) {
    connection.rcvNxt = plus(connection.rcvNxt, 1);
    owed = true;
    switch (connection.state) {
      case 'established':
        // Every application here closes as soon as its peer does.
        connection.state = 'close-wait';
        tcpClose(ctx, connection);
        break;
      case 'fin-wait-1':
        connection.state = 'closing';
        break;
      case 'fin-wait-2':
        closed = true;
        break;
      default:
        break;
    }
  }
  if (owed && connection.sndNxt === sentBefore) send(ctx, connection, flags('ack'));
  if (closed) forget(ctx, connection);
}

/** The connection heard nothing for TCP_TIMEOUT. */
export function onTcpTimer(ctx: IpContext, id: number) {
  const connection = ctx.state.transport.connections.get(id);
  if (connection) aborted(ctx, connection, 'timeout');
}
