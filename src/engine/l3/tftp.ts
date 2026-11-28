import type { Ipv4Address } from '@/model';
import { serverServices } from '@/model/defaults';
import { APP_PORT, TFTP_BLOCK, type TftpMessage } from '../apps';
import { ms, type SimTime } from '../core/time';
import { byteLength } from '../http';
import type { Ipv4Packet, UdpDatagram } from '../pdu';
import { freePort, serviceFiles, setServiceFiles, withFile } from './appState';
import { timerKey, type IpContext } from './context';
import { originate } from './output';
import { ephemeralPort } from './transport';
import { udp } from './udp';

/** What an IOS `copy` asks of a TFTP server: to store a file, or to send one. */
export type TftpRequest =
  | {
      readonly op: 'put';
      readonly server: Ipv4Address;
      readonly file: string;
      readonly content: string;
    }
  | { readonly op: 'get'; readonly server: Ipv4Address; readonly file: string };

/**
 * A transfer, step by step: a `block` for each DATA packet sent or received, then `done` or
 * `failed`. A `get`'s `done` carries the file.
 */
export type TftpEvent =
  | { readonly kind: 'block'; readonly block: number }
  | {
      readonly kind: 'done';
      readonly bytes: number;
      readonly content: string;
      /** Simulated milliseconds from the request to the last block, for IOS's transfer rate. */
      readonly elapsed: number;
    }
  | { readonly kind: 'failed'; readonly why: TftpFailure };

export type TftpFailure =
  /** No answer in time: no server, TFTP off, or no route. */
  | { readonly kind: 'timeout' }
  /** The server answered with an error, such as File not found. */
  | { readonly kind: 'error'; readonly code: number; readonly message: string }
  /** The device powered off, or stepping back undid the transfer. */
  | { readonly kind: 'cancelled' };

export type TftpListener = (event: TftpEvent) => void;

/** How long either end waits for the next packet before it gives up. */
export const TFTP_TIMEOUT = ms(5000);

type ClientTransfer = {
  readonly role: 'client';
  readonly op: 'put' | 'get';
  readonly port: number;
  readonly server: Ipv4Address;
  readonly startedAt: SimTime;
  /** The port the server answers from, once it has. */
  serverPort?: number;
  readonly file: string;
  /** All of a put's file; what a get has received so far. */
  content: string;
  /** The last block sent or received. */
  block: number;
  readonly listener: TftpListener;
};

type ServerTransfer = {
  readonly role: 'server';
  readonly op: 'read' | 'write';
  readonly port: number;
  readonly client: Ipv4Address;
  readonly clientPort: number;
  readonly file: string;
  content: string;
  block: number;
};

export type TftpTransfer = ClientTransfer | ServerTransfer;

/** The `block`th 512-character slice of the file, counting from 1. */
const slice = (content: string, block: number) =>
  content.slice((block - 1) * TFTP_BLOCK, block * TFTP_BLOCK);

/** How many DATA packets a file takes: a short last one ends it, even when it is empty. */
const blockCount = (content: string) => Math.floor(content.length / TFTP_BLOCK) + 1;

const key = (port: number) => timerKey({ kind: 'app', name: `tftp:${port}` });

function touch(ctx: IpContext, transfer: TftpTransfer) {
  ctx.setTimer(key(transfer.port), TFTP_TIMEOUT);
}

function forget(ctx: IpContext, transfer: TftpTransfer) {
  ctx.state.apps.tftp.delete(transfer.port);
  ctx.clearTimer(key(transfer.port));
}

function sendFrom(
  ctx: IpContext,
  port: number,
  to: Ipv4Address,
  toPort: number,
  message: TftpMessage,
) {
  originate(ctx, to, udp(port, toPort, message));
}

/** Starts a transfer to or from a TFTP server. Its steps go to `listener`. */
export function startTftp(ctx: IpContext, request: TftpRequest, listener: TftpListener) {
  const port = freePort(ctx, () => ephemeralPort(ctx));
  const transfer: ClientTransfer = {
    role: 'client',
    op: request.op,
    port,
    server: request.server,
    startedAt: ctx.now,
    file: request.file,
    content: request.op === 'put' ? request.content : '',
    block: 0,
    listener,
  };
  ctx.state.apps.tftp.set(port, transfer);
  touch(ctx, transfer);
  const op = request.op === 'put' ? 'wrq' : 'rrq';
  sendFrom(ctx, port, request.server, APP_PORT.tftp, {
    kind: 'tftp',
    op,
    file: request.file,
    mode: 'octet',
  });
}

const done = (ctx: IpContext, transfer: ClientTransfer): TftpEvent => ({
  kind: 'done',
  bytes: byteLength(transfer.content),
  content: transfer.content,
  elapsed: ctx.now - transfer.startedAt,
});

function end(ctx: IpContext, transfer: ClientTransfer, event: TftpEvent) {
  forget(ctx, transfer);
  transfer.listener(event);
}

/**
 * A request on port 69. A server with TFTP on answers it from a port of its own: a write with
 * ACK 0, a read with the file's first block, or File not found. Anything else stays silent.
 */
export function onTftpRequest(ctx: IpContext, packet: Ipv4Packet, datagram: UdpDatagram) {
  const message = datagram.payload;
  if (message.kind !== 'tftp' || (message.op !== 'rrq' && message.op !== 'wrq')) return;
  if (ctx.device.kind !== 'server' || !serverServices(ctx.device.config).tftp.enabled) return;
  const port = freePort(ctx, () => ephemeralPort(ctx));
  const reply = (answer: TftpMessage) => sendFrom(ctx, port, packet.src, datagram.srcPort, answer);
  if (message.op === 'rrq') {
    const file = serviceFiles(ctx, 'tftp').find((candidate) => candidate.name === message.file);
    if (!file) {
      reply({ kind: 'tftp', op: 'error', code: 1, message: 'File not found' });
      return;
    }
    const transfer: ServerTransfer = {
      role: 'server',
      op: 'read',
      port,
      client: packet.src,
      clientPort: datagram.srcPort,
      file: file.name,
      content: file.content,
      block: 1,
    };
    ctx.state.apps.tftp.set(port, transfer);
    touch(ctx, transfer);
    reply({ kind: 'tftp', op: 'data', block: 1, data: slice(file.content, 1) });
    return;
  }
  const transfer: ServerTransfer = {
    role: 'server',
    op: 'write',
    port,
    client: packet.src,
    clientPort: datagram.srcPort,
    file: message.file,
    content: '',
    block: 0,
  };
  ctx.state.apps.tftp.set(port, transfer);
  touch(ctx, transfer);
  reply({ kind: 'tftp', op: 'ack', block: 0 });
}

function onServerPacket(ctx: IpContext, transfer: ServerTransfer, message: TftpMessage) {
  const reply = (answer: TftpMessage) =>
    sendFrom(ctx, transfer.port, transfer.client, transfer.clientPort, answer);
  if (transfer.op === 'write') {
    if (message.op !== 'data' || message.block !== transfer.block + 1) return;
    transfer.block = message.block;
    transfer.content += message.data;
    reply({ kind: 'tftp', op: 'ack', block: message.block });
    if (message.data.length < TFTP_BLOCK) {
      forget(ctx, transfer);
      const file = { name: transfer.file, content: transfer.content };
      setServiceFiles(ctx, 'tftp', withFile(serviceFiles(ctx, 'tftp'), file));
    } else {
      touch(ctx, transfer);
    }
    return;
  }
  if (message.op !== 'ack' || message.block !== transfer.block) return;
  if (transfer.block >= blockCount(transfer.content)) {
    forget(ctx, transfer);
    return;
  }
  transfer.block += 1;
  touch(ctx, transfer);
  reply({
    kind: 'tftp',
    op: 'data',
    block: transfer.block,
    data: slice(transfer.content, transfer.block),
  });
}

function onClientPacket(
  ctx: IpContext,
  transfer: ClientTransfer,
  packet: Ipv4Packet,
  datagram: UdpDatagram,
  message: TftpMessage,
) {
  if (packet.src !== transfer.server) return;
  if (transfer.serverPort !== undefined && datagram.srcPort !== transfer.serverPort) return;
  if (message.op === 'error') {
    end(ctx, transfer, {
      kind: 'failed',
      why: { kind: 'error', code: message.code, message: message.message },
    });
    return;
  }
  transfer.serverPort = datagram.srcPort;
  const send = (answer: TftpMessage) =>
    sendFrom(ctx, transfer.port, transfer.server, datagram.srcPort, answer);
  if (transfer.op === 'get') {
    if (message.op !== 'data' || message.block !== transfer.block + 1) return;
    transfer.block = message.block;
    transfer.content += message.data;
    send({ kind: 'tftp', op: 'ack', block: message.block });
    transfer.listener({ kind: 'block', block: message.block });
    if (message.data.length < TFTP_BLOCK) {
      end(ctx, transfer, done(ctx, transfer));
    } else {
      touch(ctx, transfer);
    }
    return;
  }
  if (message.op !== 'ack' || message.block !== transfer.block) return;
  if (transfer.block >= blockCount(transfer.content)) {
    end(ctx, transfer, done(ctx, transfer));
    return;
  }
  transfer.block += 1;
  touch(ctx, transfer);
  send({
    kind: 'tftp',
    op: 'data',
    block: transfer.block,
    data: slice(transfer.content, transfer.block),
  });
  transfer.listener({ kind: 'block', block: transfer.block });
}

/** A TFTP packet for a port other than 69: a transfer's next step. Returns false when none runs there. */
export function onTftpTransfer(ctx: IpContext, packet: Ipv4Packet, datagram: UdpDatagram): boolean {
  const message = datagram.payload;
  const transfer = ctx.state.apps.tftp.get(datagram.dstPort);
  if (message.kind !== 'tftp' || !transfer) return false;
  if (transfer.role === 'client') onClientPacket(ctx, transfer, packet, datagram, message);
  else if (packet.src === transfer.client && datagram.srcPort === transfer.clientPort) {
    onServerPacket(ctx, transfer, message);
  }
  return true;
}

/** A transfer heard nothing for TFTP_TIMEOUT. */
export function onTftpTimer(ctx: IpContext, port: number) {
  const transfer = ctx.state.apps.tftp.get(port);
  if (!transfer) return;
  if (transfer.role === 'client') end(ctx, transfer, { kind: 'failed', why: { kind: 'timeout' } });
  else forget(ctx, transfer);
}

/** The device is going away: every transfer it started hears that it was cancelled. */
export function stopTftp(ctx: IpContext) {
  for (const transfer of [...ctx.state.apps.tftp.values()]) {
    if (transfer.role === 'client') {
      end(ctx, transfer, { kind: 'failed', why: { kind: 'cancelled' } });
    }
  }
}
