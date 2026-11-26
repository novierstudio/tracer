import type { TraceEvent } from '../../engine/api';
import { iosAddress } from '../../model/ipv6';
import type { TraceStream } from './query';

/**
 * IOS marks a probe a router refused with `!N` for an unreachable network, `!H` for a host, and
 * `!A` for one an access list denied.
 */
const UNREACHABLE = { network: '!N', host: '!H', 'admin-prohibited': '!A' } as const;

/**
 * IOS `traceroute` output, a piece at a time: the header, then a line per hop that grows as its
 * probes settle. A line holds the hop number, each new responder's address, and per probe its
 * time in msec, `*` for no answer or `!N` for a refusal. Pieces break lines with `\n`.
 */
export function tracerouteOutput({ target }: TraceStream) {
  /** The hop whose line is open, or 0 before the first. */
  let hop = 0;
  let from: string | undefined;
  const close = () => (hop === 0 ? '' : '\n');
  return {
    head: 'Type escape sequence to abort.\n' + `Tracing the route to ${target}\n\n`,
    /** The text for one event. `done` is the last event and ends the output. */
    next(event: TraceEvent): string {
      if (event.kind === 'done') return close();
      let text = '';
      if (event.hop !== hop) {
        text = `${close()}${String(event.hop).padStart(3)}`;
        hop = event.hop;
        from = undefined;
      }
      if (event.kind === 'timeout') return `${text} * `;
      if (event.from !== from) {
        text += ` ${iosAddress(event.from)}`;
        from = event.from;
      }
      if (event.kind === 'unreachable') return `${text} ${UNREACHABLE[event.code]} `;
      return `${text} ${Math.round(event.timeMs)} msec`;
    },
    /** Ends the open line. */
    abort: close,
  };
}
