import { keyword } from '../params';
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

/** EXEC commands that read the session or the simulation rather than the config. */
export const execCommands = [
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
