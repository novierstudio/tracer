import type { IpAddress } from '../../model/ipv6';
import { ipv4, keyword, num, type Keyword, type Param, type Segment } from '../params';
import { defineCommand } from '../tree';
import type { DeviceContext } from './context';

const EXEC = ['user-exec', 'priv-exec'] as const;

const command = defineCommand<DeviceContext>();
const show = keyword('show', 'Show running system information');

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A router whose clock was never set counts from boot on March 1, 1993, as IOS does. */
export const BOOT = Date.UTC(1993, 2, 1);

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/**
 * IOS `show clock`: `*00:05:12.345 UTC Mon Mar 1 1993`. The leading `*` says the time is not
 * authoritative, as on a router with no clock set and no NTP.
 */
export function formatClock(time: Date, authoritative: boolean): string {
  const clock = `${pad(time.getUTCHours())}:${pad(time.getUTCMinutes())}:${pad(time.getUTCSeconds())}.${pad(time.getUTCMilliseconds(), 3)}`;
  const date = `${DAYS[time.getUTCDay()]} ${MONTHS[time.getUTCMonth()]} ${time.getUTCDate()} ${time.getUTCFullYear()}`;
  return `${authoritative ? '' : '*'}${clock} UTC ${date}`;
}

const PING_OFFLINE = ['% The simulation is not running, so there is nothing to ping through.'];

/** IOS sends 5 echoes and waits 2 seconds for each, unless told otherwise. */
const PING_DEFAULTS = { count: 5, seconds: 2 };

interface PingArgs {
  readonly target: IpAddress;
  readonly count?: number;
  readonly seconds?: number;
}

const ping = keyword('ping', 'Send echo messages');
const repeat = [
  keyword('repeat', 'specify repeat count'),
  num('count', 1, 2147483647, 'Repeat count'),
] as const;
const timeout = [
  keyword('timeout', 'specify timeout interval'),
  num('seconds', 0, 3600, 'Timeout in seconds'),
] as const;

type Target = Param<'target', IpAddress>;

/**
 * `ping [words] <target> [repeat N] [timeout S]`, the options in either order. `words` sit between
 * `ping` and the target, as `ipv6` does in `ping ipv6 2001:db8::1`.
 */
export function pingCommands(words: readonly Keyword[], target: Target) {
  const forms: readonly (readonly Segment[])[] = [
    [],
    repeat,
    timeout,
    [...repeat, ...timeout],
    [...timeout, ...repeat],
  ];
  return forms.map((options) =>
    command({
      modes: EXEC,
      path: [ping, ...words, target, ...options],
      run: (args, ctx) => {
        const {
          target,
          count = PING_DEFAULTS.count,
          seconds = PING_DEFAULTS.seconds,
        } = args as PingArgs;
        // The engine needs a timeout above zero; IOS's `timeout 0` gives up at once.
        const timeoutMs = Math.max(seconds * 1000, 1);
        ctx.stream({ kind: 'ping', target, options: { count, timeoutMs } });
        return PING_OFFLINE;
      },
    }),
  );
}

const TRACE_OFFLINE = ['% The simulation is not running, so there is nothing to trace through.'];

/** IOS probes each hop 3 times, waits 3 seconds for each probe, and gives up after 30 hops. */
export const TRACE_OPTIONS = { maxHops: 30, probesPerHop: 3, timeoutMs: 3000 };

/** `traceroute [words] <target>`, with `words` as in `pingCommands`. */
export function tracerouteCommand(words: readonly Keyword[], target: Target) {
  return command({
    modes: EXEC,
    path: [keyword('traceroute', 'Trace route to destination'), ...words, target],
    run: ({ target }, ctx) => {
      ctx.stream({ kind: 'traceroute', target, options: TRACE_OPTIONS });
      return TRACE_OFFLINE;
    },
  });
}

/** EXEC commands that read the session or the simulation rather than the config. */
export const execCommands = [
  ...pingCommands([], ipv4('target', 'Ping destination address')),
  tracerouteCommand([], ipv4('target', 'Trace route to destination address')),
  command({
    modes: EXEC,
    path: [show, keyword('history', 'Information about Terminal history')],
    run: (_a, ctx) => ctx.history.map((line) => `  ${line}`),
  }),
  command({
    modes: EXEC,
    path: [show, keyword('clock', 'Display the system clock')],
    // The simulated clock counts from boot; with no simulation, the wall clock stands in.
    run: (_a, ctx) =>
      ctx.query('clock', (elapsed) => [
        elapsed === undefined
          ? formatClock(new Date(), true)
          : formatClock(new Date(BOOT + elapsed), false),
      ]),
  }),
];
