import type { Ipv4Address } from '@/model';
import type { IpAddress } from '@/model/ipv6';
import { ms } from '../core/time';
import type { UnreachableCode } from '../pdu';
import { timerKey, type IpContext } from './context';
import { sendEcho, type EchoAnswer, type EchoProbe } from './echo';

/** Windows sends the next echo request about a second after the last one. */
export const PING_INTERVAL = ms(1000);

/** The data size Windows sends, which a reply reports back. */
export const PING_BYTES = 32;

/** `count` is a whole number of requests, or Infinity to ping until cancelled, as `ping -t` does. */
export type PingOptions = { readonly count: number; readonly timeoutMs: number };

/** What became of one echo request. */
export type PingReply =
  | {
      readonly kind: 'reply';
      readonly seq: number;
      readonly from: IpAddress;
      readonly bytes: number;
      readonly timeMs: number;
      readonly ttl: number;
    }
  /** No answer in time. Also what a request the device had no route for comes to, as on IOS. */
  | { readonly kind: 'timeout'; readonly seq: number }
  | {
      readonly kind: 'unreachable';
      readonly seq: number;
      readonly from: IpAddress;
      readonly code: UnreachableCode;
    }
  | { readonly kind: 'ttl-expired'; readonly seq: number; readonly from: IpAddress };

export type PingSummary = {
  readonly kind: 'summary';
  readonly target: IpAddress;
  readonly sent: number;
  /** Echo replies only. Windows also counts unreachable messages as received; this does not. */
  readonly received: number;
  /** Round-trip times of the replies, absent when none came back. */
  readonly rtt?: { readonly minMs: number; readonly avgMs: number; readonly maxMs: number };
};

/** A ping reports each echo request in order, then one summary, and then nothing more. */
export type PingEvent = PingReply | PingSummary;

export type PingListener = (event: PingEvent) => void;

export type PingSession = EchoProbe & {
  readonly kind: 'ping';
  readonly count: number;
  readonly listener: PingListener;
  /** Round-trip times of the replies so far. */
  readonly times: number[];
};

/** The summary of `sent` requests whose replies took `times`. */
export function pingSummary(
  target: IpAddress,
  sent: number,
  times: readonly number[],
): PingSummary {
  const total = times.reduce((sum, time) => sum + time, 0);
  return {
    kind: 'summary',
    target,
    sent,
    received: times.length,
    ...(times.length > 0 && {
      rtt: { minMs: Math.min(...times), avgMs: total / times.length, maxMs: Math.max(...times) },
    }),
  };
}

/** Ends the ping with a summary of what it got so far. A request in flight counts as sent. */
export function finishPing(ctx: IpContext, session: PingSession) {
  ctx.state.probes.delete(session.id);
  ctx.clearTimer(timerKey({ kind: 'probe', id: session.id }));
  session.listener(pingSummary(session.target, session.phase.seq, session.times));
}

function toReply(seq: number, answer: EchoAnswer): PingReply {
  switch (answer.kind) {
    case 'reply':
      return { ...answer, seq, bytes: PING_BYTES };
    case 'unreachable':
      return { kind: 'unreachable', seq, from: answer.from, code: answer.code };
    case 'ttl-expired':
      return { kind: 'ttl-expired', seq, from: answer.from };
    case 'timeout':
      return { kind: 'timeout', seq };
  }
}

/** The request in flight is answered or timed out: report it, then pause or finish. */
export function onPingAnswer(ctx: IpContext, session: PingSession, answer: EchoAnswer) {
  const { phase } = session;
  if (phase.kind !== 'awaiting-reply') return;
  if (answer.kind === 'reply') session.times.push(answer.timeMs);
  session.listener(toReply(phase.seq, answer));
  if (phase.seq >= session.count) {
    finishPing(ctx, session);
    return;
  }
  session.phase = { kind: 'pausing', seq: phase.seq };
  const wait = Math.max(0, phase.sentAt + PING_INTERVAL - ctx.now);
  ctx.setTimer(timerKey({ kind: 'probe', id: session.id }), ms(wait));
}

/** Starts a ping from this device and returns its id. Its events go to `listener` as time passes. */
export function startPing(
  ctx: IpContext,
  target: Ipv4Address,
  { count, timeoutMs }: PingOptions,
  listener: PingListener,
): number {
  const session: PingSession = {
    kind: 'ping',
    id: ctx.state.nextProbeId++,
    target,
    count,
    timeout: ms(timeoutMs),
    listener,
    phase: { kind: 'pausing', seq: 0 },
    times: [],
  };
  ctx.state.probes.set(session.id, session);
  sendEcho(ctx, session);
  return session.id;
}

/** The ping's timer: the pause before the next request ended, or the request in flight timed out. */
export function onPingTimer(ctx: IpContext, session: PingSession) {
  if (session.phase.kind === 'pausing') sendEcho(ctx, session);
  else onPingAnswer(ctx, session, { kind: 'timeout' });
}
