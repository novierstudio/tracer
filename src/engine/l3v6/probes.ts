import type { Ipv6Address } from '@/model/ipv6';
import { ms, type SimDuration } from '../core/time';
import type { EchoAnswer, ProbePhase } from '../l3/echo';
import {
  PING_BYTES,
  PING_INTERVAL,
  pingSummary,
  type PingListener,
  type PingOptions,
  type PingReply,
} from '../l3/ping';
import type { TraceListener, TraceOptions } from '../l3/traceroute';
import type { Icmpv6Message, Ipv6Packet } from '../pdu6';
import { originate6 } from './output';
import { timerKey, type Ipv6Context } from './state';

/**
 * IPv6's ping and traceroute: the same echo requests, one at a time, and the same events as
 * IPv4's, carried by ICMPv6. Time Exceeded answers a traceroute probe whose hop limit ran out.
 */

type EchoProbe6 = {
  readonly id: number;
  readonly target: Ipv6Address;
  readonly timeout: SimDuration;
  phase: ProbePhase;
};

export type Ping6Session = EchoProbe6 & {
  readonly kind: 'ping';
  readonly count: number;
  readonly listener: PingListener;
  readonly times: number[];
};

export type Trace6Session = EchoProbe6 & {
  readonly kind: 'trace';
  readonly maxHops: number;
  readonly probesPerHop: number;
  readonly listener: TraceListener;
  reached: boolean;
};

export type Probe6 = Ping6Session | Trace6Session;

function sendEcho6(ctx: Ipv6Context, probe: EchoProbe6, hopLimit?: number) {
  const seq = probe.phase.seq + 1;
  probe.phase = { kind: 'awaiting-reply', seq, sentAt: ctx.now };
  ctx.setTimer(timerKey({ kind: 'probe', id: probe.id }), probe.timeout);
  const echo = { kind: 'icmpv6', type: 'echo-request', id: probe.id, seq } as const;
  originate6(ctx, probe.target, echo, { hopLimit });
}

/** The echo request an ICMPv6 message answers: a reply echoes it, an error quotes it. */
function answeredEcho(message: Icmpv6Message) {
  switch (message.type) {
    case 'echo-reply':
      return message;
    case 'destination-unreachable':
    case 'time-exceeded': {
      const quoted = message.original.payload;
      return quoted.type === 'echo-request' ? quoted : undefined;
    }
    default:
      return undefined;
  }
}

/**
 * An ICMPv6 message arrived for this device. If it answers the request a probe awaits, returns the
 * probe and what the answer says. Both unreachable codes read as a host unreachable, as Packet
 * Tracer's PC words them.
 */
export function matchAnswer6(
  ctx: Ipv6Context,
  packet: Ipv6Packet,
): { probe: Probe6; answer: EchoAnswer } | undefined {
  const message = packet.payload;
  const echo = answeredEcho(message);
  const probe = echo && ctx.state.probes.get(echo.id);
  if (!probe || probe.phase.kind !== 'awaiting-reply' || probe.phase.seq !== echo.seq) return;
  const from = packet.src;
  const timeMs = ctx.now - probe.phase.sentAt;
  switch (message.type) {
    case 'echo-reply':
      return { probe, answer: { kind: 'reply', from, timeMs, ttl: packet.hopLimit } };
    case 'destination-unreachable':
      return { probe, answer: { kind: 'unreachable', from, code: 'host', timeMs } };
    case 'time-exceeded':
      return { probe, answer: { kind: 'ttl-expired', from, timeMs } };
    default:
      return undefined;
  }
}

function finishPing6(ctx: Ipv6Context, session: Ping6Session) {
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

function onPingAnswer6(ctx: Ipv6Context, session: Ping6Session, answer: EchoAnswer) {
  const { phase } = session;
  if (phase.kind !== 'awaiting-reply') return;
  if (answer.kind === 'reply') session.times.push(answer.timeMs);
  session.listener(toReply(phase.seq, answer));
  if (phase.seq >= session.count) {
    finishPing6(ctx, session);
    return;
  }
  session.phase = { kind: 'pausing', seq: phase.seq };
  const wait = Math.max(0, phase.sentAt + PING_INTERVAL - ctx.now);
  ctx.setTimer(timerKey({ kind: 'probe', id: session.id }), ms(wait));
}

export function startPing6(
  ctx: Ipv6Context,
  target: Ipv6Address,
  { count, timeoutMs }: PingOptions,
  listener: PingListener,
): number {
  const session: Ping6Session = {
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
  sendEcho6(ctx, session);
  return session.id;
}

function placeOf(session: Trace6Session, seq: number) {
  return {
    hop: Math.ceil(seq / session.probesPerHop),
    probe: ((seq - 1) % session.probesPerHop) + 1,
  };
}

function finishTrace6(ctx: Ipv6Context, session: Trace6Session) {
  ctx.state.probes.delete(session.id);
  ctx.clearTimer(timerKey({ kind: 'probe', id: session.id }));
  session.listener({ kind: 'done' });
}

function onTraceAnswer6(ctx: Ipv6Context, session: Trace6Session, answer: EchoAnswer) {
  if (session.phase.kind !== 'awaiting-reply') return;
  const { hop, probe } = placeOf(session, session.phase.seq);
  session.listener({ ...answer, hop, probe });
  if (answer.kind === 'reply') session.reached = true;
  if (answer.kind === 'unreachable') finishTrace6(ctx, session);
  else if (probe < session.probesPerHop) sendEcho6(ctx, session, hop);
  else if (session.reached || hop >= session.maxHops) finishTrace6(ctx, session);
  else sendEcho6(ctx, session, hop + 1);
}

export function startTrace6(
  ctx: Ipv6Context,
  target: Ipv6Address,
  { maxHops, probesPerHop, timeoutMs }: TraceOptions,
  listener: TraceListener,
): number {
  const session: Trace6Session = {
    kind: 'trace',
    id: ctx.state.nextProbeId++,
    target,
    timeout: ms(timeoutMs),
    maxHops,
    probesPerHop,
    listener,
    phase: { kind: 'pausing', seq: 0 },
    reached: false,
  };
  ctx.state.probes.set(session.id, session);
  sendEcho6(ctx, session, 1);
  return session.id;
}

/** An answer, or a timeout, for the probe's request in flight. */
export function onProbeAnswer6(ctx: Ipv6Context, probe: Probe6, answer: EchoAnswer) {
  if (probe.kind === 'ping') onPingAnswer6(ctx, probe, answer);
  else onTraceAnswer6(ctx, probe, answer);
}

/** The probe's timer: a ping's pause ended, or the request in flight timed out. */
export function onProbeTimer6(ctx: Ipv6Context, probe: Probe6) {
  if (probe.kind === 'ping' && probe.phase.kind === 'pausing') sendEcho6(ctx, probe);
  else onProbeAnswer6(ctx, probe, { kind: 'timeout' });
}

/** Ends a ping or traceroute now, with the summary so far or `done`. */
export function stopProbe6(ctx: Ipv6Context, id: number) {
  const probe = ctx.state.probes.get(id);
  if (probe?.kind === 'ping') finishPing6(ctx, probe);
  else if (probe?.kind === 'trace') finishTrace6(ctx, probe);
}
