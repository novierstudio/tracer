import type { Ipv4Address } from '@/model';
import type { IpAddress } from '@/model/ipv6';
import type { SimDuration, SimTime } from '../core/time';
import type { IcmpEcho, IcmpMessage, Ipv4Packet, UnreachableCode } from '../pdu';
import { timerKey, type IpContext, type Probe } from './context';
import { originate } from './output';

/** Where a probe is: waiting on request `seq`'s answer, or pausing after it before the next. */
export type ProbePhase =
  | { readonly kind: 'awaiting-reply'; readonly seq: number; readonly sentAt: SimTime }
  | { readonly kind: 'pausing'; readonly seq: number };

/** What a ping and a traceroute share: echo requests to one target, one at a time. */
export type EchoProbe = {
  readonly id: number;
  readonly target: Ipv4Address;
  readonly timeout: SimDuration;
  phase: ProbePhase;
};

/** What became of one echo request, as the device that sent it sees it. */
export type EchoAnswer =
  | {
      readonly kind: 'reply';
      readonly from: IpAddress;
      readonly timeMs: number;
      readonly ttl: number;
    }
  | {
      readonly kind: 'unreachable';
      readonly from: IpAddress;
      readonly code: UnreachableCode;
      readonly timeMs: number;
    }
  | { readonly kind: 'ttl-expired'; readonly from: IpAddress; readonly timeMs: number }
  /** No answer in time. Also what a request the device had no route for comes to, as on IOS. */
  | { readonly kind: 'timeout' };

/** Sends the probe's next echo request, with `ttl` or the device's initial TTL. */
export function sendEcho(ctx: IpContext, probe: EchoProbe, ttl?: number) {
  const seq = probe.phase.seq + 1;
  probe.phase = { kind: 'awaiting-reply', seq, sentAt: ctx.now };
  ctx.setTimer(timerKey({ kind: 'probe', id: probe.id }), probe.timeout);
  originate(ctx, probe.target, { kind: 'icmp', type: 'echo-request', id: probe.id, seq }, { ttl });
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

/**
 * An ICMP message arrived for this device. If it answers the request a probe awaits, returns the
 * probe and what the answer says.
 */
export function matchAnswer(
  ctx: IpContext,
  packet: Ipv4Packet,
  message: IcmpMessage,
): { probe: Probe; answer: EchoAnswer } | undefined {
  const echo = answeredEcho(message);
  const probe = echo && ctx.state.probes.get(echo.id);
  if (!probe || probe.phase.kind !== 'awaiting-reply' || probe.phase.seq !== echo.seq) return;
  const from = packet.src;
  const timeMs = ctx.now - probe.phase.sentAt;
  switch (message.type) {
    case 'echo-reply':
      return { probe, answer: { kind: 'reply', from, timeMs, ttl: packet.ttl } };
    case 'destination-unreachable':
      return { probe, answer: { kind: 'unreachable', from, code: message.code, timeMs } };
    case 'time-exceeded':
      return { probe, answer: { kind: 'ttl-expired', from, timeMs } };
    case 'echo-request':
      return undefined;
  }
}
