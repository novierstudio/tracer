import type { Ipv4Address } from '@/model';
import { ms, type SimDuration, type SimTime } from '../core/time';
import type { IcmpEcho, IcmpMessage, Ipv4Packet, UnreachableCode } from '../pdu';
import { timerKey, type IpContext } from './context';
import { originate } from './output';

/** Windows sends the next echo request about a second after the last one. */
export const PING_INTERVAL = ms(1000);

/** The data size Windows sends, which a reply reports back. */
export const PING_BYTES = 32;

export type PingOptions = { readonly count: number; readonly timeoutMs: number };

/** What became of one echo request. */
export type PingReply =
  | {
      readonly kind: 'reply';
      readonly seq: number;
      readonly from: Ipv4Address;
      readonly bytes: number;
      readonly timeMs: number;
      readonly ttl: number;
    }
  /** No answer in time. Also what a request the device had no route for comes to, as on IOS. */
  | { readonly kind: 'timeout'; readonly seq: number }
  | {
      readonly kind: 'unreachable';
      readonly seq: number;
      readonly from: Ipv4Address;
      readonly code: UnreachableCode;
    }
  | { readonly kind: 'ttl-expired'; readonly seq: number; readonly from: Ipv4Address };

export type PingSummary = {
  readonly kind: 'summary';
  readonly target: Ipv4Address;
  readonly sent: number;
  /** Echo replies only. Windows also counts unreachable messages as received; this does not. */
  readonly received: number;
  /** Round-trip times of the replies, absent when none came back. */
  readonly rtt?: { readonly minMs: number; readonly avgMs: number; readonly maxMs: number };
};

/** A ping reports each echo request in order, then one summary, and then nothing more. */
export type PingEvent = PingReply | PingSummary;

export type PingListener = (event: PingEvent) => void;

type PingPhase =
  | { readonly kind: 'awaiting-reply'; readonly seq: number; readonly sentAt: SimTime }
  /** Request `seq` is settled and the next one waits for the interval. */
  | { readonly kind: 'pausing'; readonly seq: number };

export type PingSession = {
  readonly id: number;
  readonly target: Ipv4Address;
  readonly count: number;
  readonly timeout: SimDuration;
  readonly listener: PingListener;
  phase: PingPhase;
  /** Round-trip times of the replies so far. */
  readonly times: number[];
};

function sendEcho(ctx: IpContext, session: PingSession) {
  const seq = session.phase.seq + 1;
  session.phase = { kind: 'awaiting-reply', seq, sentAt: ctx.now };
  ctx.setTimer(timerKey({ kind: 'ping', id: session.id }), session.timeout);
  originate(ctx, session.target, { kind: 'icmp', type: 'echo-request', id: session.id, seq });
}

function finish(ctx: IpContext, session: PingSession) {
  ctx.state.pings.delete(session.id);
  ctx.clearTimer(timerKey({ kind: 'ping', id: session.id }));
  const { times } = session;
  const total = times.reduce((sum, time) => sum + time, 0);
  session.listener({
    kind: 'summary',
    target: session.target,
    sent: session.phase.seq,
    received: times.length,
    ...(times.length > 0 && {
      rtt: { minMs: Math.min(...times), avgMs: total / times.length, maxMs: Math.max(...times) },
    }),
  });
}

/** The request in flight is answered or timed out: report it, then pause or finish. */
function settle(
  ctx: IpContext,
  session: PingSession,
  phase: Extract<PingPhase, { kind: 'awaiting-reply' }>,
  reply: PingReply,
) {
  session.listener(reply);
  if (phase.seq >= session.count) {
    finish(ctx, session);
    return;
  }
  session.phase = { kind: 'pausing', seq: phase.seq };
  const wait = Math.max(0, phase.sentAt + PING_INTERVAL - ctx.now);
  ctx.setTimer(timerKey({ kind: 'ping', id: session.id }), ms(wait));
}

/** Starts a ping from this device. Its events go to `listener` as simulated time passes. */
export function startPing(
  ctx: IpContext,
  target: Ipv4Address,
  { count, timeoutMs }: PingOptions,
  listener: PingListener,
) {
  const session: PingSession = {
    id: ctx.state.nextPingId++,
    target,
    count,
    timeout: ms(timeoutMs),
    listener,
    phase: { kind: 'pausing', seq: 0 },
    times: [],
  };
  ctx.state.pings.set(session.id, session);
  sendEcho(ctx, session);
}

export function onPingTimer(ctx: IpContext, id: number) {
  const session = ctx.state.pings.get(id);
  if (!session) return;
  const { phase } = session;
  if (phase.kind === 'pausing') sendEcho(ctx, session);
  else settle(ctx, session, phase, { kind: 'timeout', seq: phase.seq });
}

/** The echo request an ICMP message answers: a reply echoes it, an error quotes it. */
function answeredEcho(message: IcmpMessage): IcmpEcho | undefined {
  switch (message.type) {
    case 'echo-reply':
      return message;
    case 'echo-request':
      return undefined;
    case 'destination-unreachable':
    case 'time-exceeded': {
      const quoted = message.original.payload;
      return quoted.kind === 'icmp' && quoted.type === 'echo-request' ? quoted : undefined;
    }
  }
}

/** An ICMP message arrived for this device. If it answers the request a ping awaits, settle it. */
export function onPingAnswer(ctx: IpContext, packet: Ipv4Packet, message: IcmpMessage) {
  const echo = answeredEcho(message);
  const session = echo && ctx.state.pings.get(echo.id);
  if (!session || session.phase.kind !== 'awaiting-reply' || session.phase.seq !== echo.seq) return;
  const { phase } = session;
  const { seq } = phase;
  const from = packet.src;
  switch (message.type) {
    case 'echo-reply': {
      const timeMs = ctx.now - phase.sentAt;
      session.times.push(timeMs);
      settle(ctx, session, phase, {
        kind: 'reply',
        seq,
        from,
        bytes: PING_BYTES,
        timeMs,
        ttl: packet.ttl,
      });
      return;
    }
    case 'destination-unreachable':
      settle(ctx, session, phase, { kind: 'unreachable', seq, from, code: message.code });
      return;
    case 'time-exceeded':
      settle(ctx, session, phase, { kind: 'ttl-expired', seq, from });
      return;
    case 'echo-request':
      return;
  }
}

/** The device is going away: every ping it runs ends with a summary of what it got so far. */
export function endPings(ctx: IpContext) {
  for (const session of [...ctx.state.pings.values()]) finish(ctx, session);
}
