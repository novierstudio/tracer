import type { PingEvent, PingReply, PingSummary } from '../../engine/api';
import type { PingStream } from './query';

/** IOS prints one mark per echo request. `&` is IOS's mark for an expired TTL. */
const MARKS: Readonly<Record<PingReply['kind'], string>> = {
  reply: '!',
  timeout: '.',
  unreachable: 'U',
  'ttl-expired': '&',
};

/** IOS sends 100-byte echoes. The engine's size differs, but nothing here depends on it. */
const IOS_PING_BYTES = 100;

function successRate(sent: number, received: number, rtt: PingSummary['rtt']): string {
  const percent = sent === 0 ? 0 : Math.floor((100 * received) / sent);
  const rate = `Success rate is ${percent} percent (${received}/${sent})`;
  if (!rtt) return rate;
  const times = [rtt.minMs, rtt.avgMs, rtt.maxMs].map(Math.round).join('/');
  return `${rate}, round-trip min/avg/max = ${times} ms`;
}

function rttOf(times: readonly number[]): PingSummary['rtt'] {
  if (times.length === 0) return undefined;
  const total = times.reduce((sum, time) => sum + time, 0);
  return { minMs: Math.min(...times), avgMs: total / times.length, maxMs: Math.max(...times) };
}

/**
 * IOS `ping` output, a piece at a time: the header, a mark per echo request as it settles, then
 * the success rate. Pieces break lines with `\n`.
 */
export function pingOutput({ target, options }: PingStream) {
  const settled: PingReply[] = [];
  return {
    head:
      'Type escape sequence to abort.\n' +
      `Sending ${options.count}, ${IOS_PING_BYTES}-byte ICMP Echos to ${target}, ` +
      `timeout is ${Math.floor(options.timeoutMs / 1000)} seconds:\n`,
    /** The text for one event. The summary is the last event and ends the output. */
    next(event: PingEvent): string {
      if (event.kind === 'summary') {
        return `\n${successRate(event.sent, event.received, event.rtt)}\n`;
      }
      settled.push(event);
      return MARKS[event.kind];
    },
    /** The success rate of the requests settled so far. The first request goes out at once. */
    abort(): string {
      const times = settled.flatMap((event) => (event.kind === 'reply' ? [event.timeMs] : []));
      const sent = Math.max(settled.length, 1);
      return `\n${successRate(sent, times.length, rttOf(times))}\n`;
    },
  };
}
