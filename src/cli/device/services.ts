import type { NtpAssociation, NtpStatus } from '../../engine/api';
import type { Ipv4Address } from '../../model';
import { choice, ipv4, keyword, num } from '../params';
import { defineCommand } from '../tree';
import type { DeviceContext, IosDevice } from './context';
import { formatClock } from './exec';
import { DEFAULT_TRAP_LEVEL, TRAP_LEVELS, type TrapName } from './servicesConfig';

/** NTP and syslog: `ntp server`, `logging` and the show commands that read them. */

const command = defineCommand<DeviceContext>();

const EXEC = ['user-exec', 'priv-exec'] as const;
const GLOBAL = ['global-config'] as const;

const NOTHING: readonly string[] = [];

const ntp = keyword('ntp', 'Configure NTP');
const logging = keyword('logging', 'Modify message logging facilities');
const trap = keyword('trap', 'Set syslog server logging level');
const showNtp = [
  keyword('show', 'Show running system information'),
  keyword('ntp', 'Network time protocol'),
] as const;

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

const configCommands = [
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

/** Seconds from NTP's epoch, 1900, to 1970. */
const NTP_ERA = 2_208_988_800;

const hex8 = (n: number) => n.toString(16).toUpperCase().padStart(8, '0');

/** An NTP timestamp as IOS prints it: seconds since 1900, a dot, then the fraction of a second. */
function ntpTimestamp(time: number): string {
  const millis = ((time % 1000) + 1000) % 1000;
  return `${hex8(Math.floor(time / 1000) + NTP_ERA)}.${hex8(Math.floor((millis / 1000) * 2 ** 32))}`;
}

const FREQUENCY = 'nominal freq is 250.0000 Hz, actual freq is 249.9990 Hz, precision is 2**19';

/** `show ntp status`, as Packet Tracer prints it. */
function showNtpStatus(status: NtpStatus | undefined): string[] {
  const sync = status?.sync;
  if (!sync) {
    return [
      'Clock is unsynchronized, stratum 16, no reference clock',
      FREQUENCY,
      'reference time is 00000000.00000000 (00:00:00.000 UTC Mon Jan 1 1900)',
      'clock offset is 0.00 msec, root delay is 0.00  msec',
      'root dispersion is 0.00 msec, peer dispersion is 0.00 msec.',
      "loopfilter state is 'NSET' (Never set), drift is 0.000000000 s/s",
      'system poll interval is 6, never updated.',
    ];
  }
  return [
    `Clock is synchronized, stratum ${sync.stratum}, reference is ${sync.server}`,
    FREQUENCY,
    `reference time is ${ntpTimestamp(sync.reference)} (${formatClock(new Date(sync.reference), true)})`,
    'clock offset is 0.00 msec, root delay is 0.00  msec',
    'root dispersion is 0.02 msec, peer dispersion is 0.02 msec.',
    "loopfilter state is 'CTRL' (Normal Controlled Loop), drift is - 0.000001193 s/s " +
      `system poll interval is 4, last update was ${sync.lastUpdate} sec ago.`,
  ];
}

const ASSOCIATIONS_HEADER =
  'address         ref clock       st   when     poll    reach  delay          offset            disp';
const ASSOCIATIONS_LEGEND =
  ' * sys.peer, # selected, + candidate, - outlyer, x falseticker, ~ configured';

function associationRow(peer: NtpAssociation): string {
  return [
    `${peer.selected ? '*' : ' '}~${peer.address}`.padEnd(16),
    peer.reference.padEnd(16),
    String(peer.stratum).padEnd(5),
    (peer.when === undefined ? '-' : String(peer.when)).padEnd(9),
    String(peer.poll).padEnd(8),
    peer.reach.toString(8).padEnd(7),
    peer.delay.toFixed(2).padEnd(15),
    peer.offset.toFixed(2).padEnd(18),
    '0.12',
  ].join('');
}

/** Packet Tracer polls every 16 seconds. */
const POLL = 16;

/** What `show ntp associations` lists before any server answers: each configured one. */
const unanswered = (device: IosDevice): NtpAssociation[] =>
  (device.config.ntpServers ?? []).map((address) => ({
    address,
    reference: '.INIT.',
    stratum: 16,
    when: undefined,
    poll: POLL,
    reach: 0,
    delay: 0,
    offset: 0,
    selected: false,
  }));

/** `show ntp associations`. With no simulation, each configured server is still unanswered. */
function showNtpAssociations(status: NtpStatus | undefined, device: IosDevice): string[] {
  const peers = status?.associations ?? unanswered(device);
  return [ASSOCIATIONS_HEADER, ...peers.map(associationRow), ASSOCIATIONS_LEGEND];
}

const showCommands = [
  command({
    modes: EXEC,
    path: [...showNtp, keyword('status', 'Status of NTP')],
    run: (_a, ctx) => ctx.query('ntp', showNtpStatus),
  }),
  command({
    modes: EXEC,
    path: [...showNtp, keyword('associations', 'NTP associations')],
    run: (_a, ctx) => ctx.query('ntp', showNtpAssociations),
  }),
];

export const servicesCommands = [...configCommands, ...showCommands];
