import type { Ipv4Address } from '@/model';
import { ms } from '../core/time';
import { timerKey, type IpContext } from './context';
import { sendEcho, type EchoAnswer, type EchoProbe } from './echo';

export type TraceOptions = {
  /** The TTL of the last hop probed. Windows and IOS stop at 30. */
  readonly maxHops: number;
  readonly probesPerHop: number;
  readonly timeoutMs: number;
};

/**
 * What came back for probe `probe` of hop `hop`, whose echo request left with TTL `hop`. A router
 * on the way answers `ttl-expired` and the target answers `reply`.
 */
export type TraceProbe = EchoAnswer & { readonly hop: number; readonly probe: number };

/**
 * A traceroute reports each probe in order, then `done`, and then nothing more. It is done after
 * the hop the target answered in, after a Destination Unreachable, after `maxHops`, or when it is
 * cancelled.
 */
export type TraceEvent = TraceProbe | { readonly kind: 'done' };

export type TraceListener = (event: TraceEvent) => void;

export type TraceSession = EchoProbe & {
  readonly kind: 'trace';
  readonly maxHops: number;
  readonly probesPerHop: number;
  readonly listener: TraceListener;
  /** Whether the target answered a probe of this hop, so the trace ends with the hop. */
  reached: boolean;
};

/** The hop and probe number of echo request `seq`, both counting from 1. */
function placeOf(session: TraceSession, seq: number) {
  return {
    hop: Math.ceil(seq / session.probesPerHop),
    probe: ((seq - 1) % session.probesPerHop) + 1,
  };
}

export function finishTrace(ctx: IpContext, session: TraceSession) {
  ctx.state.probes.delete(session.id);
  ctx.clearTimer(timerKey({ kind: 'probe', id: session.id }));
  session.listener({ kind: 'done' });
}

/**
 * The probe in flight is answered or timed out: report it, then probe again, move to the next
 * hop, or finish. Each probe goes out as soon as the last one settles, as on Windows and IOS.
 */
export function onTraceAnswer(ctx: IpContext, session: TraceSession, answer: EchoAnswer) {
  if (session.phase.kind !== 'awaiting-reply') return;
  const { hop, probe } = placeOf(session, session.phase.seq);
  session.listener({ ...answer, hop, probe });
  if (answer.kind === 'reply') session.reached = true;
  if (answer.kind === 'unreachable') {
    finishTrace(ctx, session);
  } else if (probe < session.probesPerHop) {
    sendEcho(ctx, session, hop);
  } else if (session.reached || hop >= session.maxHops) {
    finishTrace(ctx, session);
  } else {
    sendEcho(ctx, session, hop + 1);
  }
}

/**
 * Starts a traceroute from this device and returns its id: echo requests with TTL 1, 2, 3 and on,
 * `probesPerHop` per TTL, each waiting up to `timeoutMs`. Its events go to `listener`.
 */
export function startTrace(
  ctx: IpContext,
  target: Ipv4Address,
  { maxHops, probesPerHop, timeoutMs }: TraceOptions,
  listener: TraceListener,
): number {
  const session: TraceSession = {
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
  sendEcho(ctx, session, 1);
  return session.id;
}
