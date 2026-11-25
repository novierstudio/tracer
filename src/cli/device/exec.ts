import type { Ipv4Address } from '../../model';
import { ipv4, keyword, num, type Segment } from '../params';
import { defineCommand } from '../tree';
import type { DeviceContext } from './context';

const EXEC = ['user-exec', 'priv-exec'] as const;

const command = defineCommand<DeviceContext>();
const show = keyword('show', 'Show running system information');

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A router whose clock was never set counts from boot on March 1, 1993, as IOS does. */
const BOOT = Date.UTC(1993, 2, 1);

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
  readonly target: Ipv4Address;
  readonly count?: number;
  readonly seconds?: number;
}

const ping = keyword('ping', 'Send echo messages');
const target = ipv4('target', 'Ping destination address');
const repeat = [
  keyword('repeat', 'specify repeat count'),
  num('count', 1, 2147483647, 'Repeat count'),
] as const;
const timeout = [
  keyword('timeout', 'specify timeout interval'),
  num('seconds', 0, 3600, 'Timeout in seconds'),
] as const;

/** `ping <ip> [repeat N] [timeout S]`, the options in either order. */
function pingCommand(options: readonly Segment[]) {
  return command({
    modes: EXEC,
    path: [ping, target, ...options],
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
  });
}

/** EXEC commands that read the session or the simulation rather than the config. */
export const execCommands = [
  pingCommand([]),
  pingCommand(repeat),
  pingCommand(timeout),
  pingCommand([...repeat, ...timeout]),
  pingCommand([...timeout, ...repeat]),
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
