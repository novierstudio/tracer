import type { Ipv4Address } from '../../model';
import { choice, ipv4, keyword, num } from '../params';
import { defineCommand } from '../tree';
import type { DeviceContext } from './context';
import { DEFAULT_TRAP_LEVEL, TRAP_LEVELS, type TrapName } from './servicesConfig';

/** NTP and syslog: `ntp server`, `logging` and the show commands that read them. */

const command = defineCommand<DeviceContext>();

const GLOBAL = ['global-config'] as const;

const NOTHING: readonly string[] = [];

const ntp = keyword('ntp', 'Configure NTP');
const logging = keyword('logging', 'Modify message logging facilities');
const trap = keyword('trap', 'Set syslog server logging level');

const withAddress = (list: Ipv4Address[] | undefined, address: Ipv4Address): Ipv4Address[] =>
  list?.includes(address) ? list : [...(list ?? []), address];

/** The list without `address`, or undefined once it is empty, as the config keeps it. */
function without(list: readonly Ipv4Address[] | undefined, address: Ipv4Address | undefined) {
  const rest = (list ?? []).filter((entry) => entry !== address);
  return rest.length > 0 ? rest : undefined;
}

function addLoggingHost({ host }: { host: Ipv4Address }, ctx: DeviceContext) {
  ctx.device.config.loggingHosts = withAddress(ctx.device.config.loggingHosts, host);
  return NOTHING;
}

function removeLoggingHost({ host }: { host?: Ipv4Address }, ctx: DeviceContext) {
  const rest = without(ctx.device.config.loggingHosts, host);
  if (rest) ctx.device.config.loggingHosts = rest;
  else delete ctx.device.config.loggingHosts;
  return NOTHING;
}

function setTrap(level: number, ctx: DeviceContext) {
  if (level === DEFAULT_TRAP_LEVEL) delete ctx.device.config.loggingTrap;
  else ctx.device.config.loggingTrap = level;
  return NOTHING;
}

const resetTrap = (_a: object, ctx: DeviceContext) => setTrap(DEFAULT_TRAP_LEVEL, ctx);

const TRAP_NAMES = Object.fromEntries(TRAP_LEVELS) as Record<TrapName, string>;

export const servicesCommands = [
  command({
    modes: GLOBAL,
    path: [ntp, keyword('server', 'Configure NTP server'), ipv4('server', 'IP address of peer')],
    run: ({ server }, ctx) => {
      ctx.device.config.ntpServers = withAddress(ctx.device.config.ntpServers, server);
      return NOTHING;
    },
    no: ({ server }, ctx) => {
      const rest = without(ctx.device.config.ntpServers, server);
      if (rest) ctx.device.config.ntpServers = rest;
      else delete ctx.device.config.ntpServers;
      return NOTHING;
    },
  }),
  command({
    modes: GLOBAL,
    path: [logging, ipv4('host', 'IP address of the logging host')],
    run: addLoggingHost,
    no: removeLoggingHost,
  }),
  command({
    modes: GLOBAL,
    path: [
      logging,
      keyword('host', 'Set syslog server IP address and parameters'),
      ipv4('host', 'IP address of the syslog server'),
    ],
    run: addLoggingHost,
    no: removeLoggingHost,
  }),
  command({
    modes: GLOBAL,
    path: [logging, trap, num('level', 0, 7, 'Logging severity level')],
    run: ({ level }, ctx) => setTrap(level, ctx),
    no: resetTrap,
  }),
  command({
    modes: GLOBAL,
    path: [logging, trap, choice('name', TRAP_NAMES)],
    run: ({ name }, ctx) =>
      setTrap(
        TRAP_LEVELS.findIndex(([level]) => level === name),
        ctx,
      ),
    no: resetTrap,
  }),
];
