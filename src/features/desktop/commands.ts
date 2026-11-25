import { err, Ipv4Address, ok, type Result } from '@/model';

/** A Command Prompt line, parsed. `count` is `Infinity` for `ping -t`. */
export type HostCommand =
  | { kind: 'empty' }
  | { kind: 'ping'; target: Ipv4Address; count: number }
  | { kind: 'ipconfig'; all: boolean }
  | { kind: 'arp-show' }
  | { kind: 'arp-clear' }
  | { kind: 'help' }
  | { kind: 'cls' };

/** A line that does not parse, as the lines to print instead. */
export type ParseError = readonly string[];

export const DEFAULT_PING_COUNT = 4;
const MAX_PING_COUNT = 4294967295;

export const PING_USAGE = [
  '',
  'Usage: ping [-t] [-n count] target_name',
  '',
  'Options:',
  '    -t             Ping the specified host until stopped.',
  '                   To stop, press Control-C.',
  '    -n count       Number of echo requests to send.',
  '',
];

const IPCONFIG_USAGE = [
  '',
  'USAGE:',
  '    ipconfig [/all]',
  '',
  'Options:',
  '    /all     Display full configuration information.',
  '',
];

const ARP_USAGE = [
  '',
  'Displays and modifies the IP-to-Physical address translation tables used by',
  'address resolution protocol (ARP).',
  '',
  'ARP -a',
  'ARP -d',
  '',
  '  -a            Displays current ARP entries.',
  '  -d            Deletes all ARP entries.',
  '',
];

export const HELP = [
  '',
  'Available commands:',
  '',
  '  arp -a          Show the ARP cache: IP addresses this host has resolved to MACs.',
  '  arp -d          Clear the ARP cache.',
  '  cls             Clear the screen.',
  '  help            Show this list.',
  '  ipconfig        Show the IP address, subnet mask and default gateway.',
  '  ipconfig /all   Also show the MAC address, DHCP and DNS settings.',
  '  ping <ip>       Send 4 echo requests. -n <count> sends more or fewer,',
  '                  -t keeps going until Ctrl+C.',
  '',
  'Up and Down recall earlier commands. Ctrl+C stops a running command.',
  '',
];

/** Windows accepts `-n` and `/n` alike, in any case. */
const flag = (word: string) => (/^[-/]/.test(word) ? word.slice(1).toLowerCase() : undefined);

function parsePing(args: readonly string[]): Result<HostCommand, ParseError> {
  let count = DEFAULT_PING_COUNT;
  let target: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const word = args[i]!;
    const option = flag(word);
    if (option === undefined) {
      if (target !== undefined) return err([`Bad parameter ${word}.`]);
      target = word;
    } else if (option === '?') {
      return err(PING_USAGE);
    } else if (option === 't') {
      count = Infinity;
    } else if (option === 'n') {
      const value = args[++i];
      if (value === undefined) return err([`Value must be supplied for option ${word}.`]);
      const n = /^\d+$/.test(value) ? Number(value) : NaN;
      if (!(n >= 1 && n <= MAX_PING_COUNT)) {
        return err([`Bad value for option ${word}, valid range is from 1 to ${MAX_PING_COUNT}.`]);
      }
      count = n;
    } else {
      return err([`Bad option ${word}.`, ...PING_USAGE]);
    }
  }
  if (target === undefined) return err(PING_USAGE);
  const address = Ipv4Address.safeParse(target);
  if (!address.success) {
    return err([
      `Ping request could not find host ${target}. Please check the name and try again.`,
    ]);
  }
  return ok({ kind: 'ping', target: address.data, count });
}

function parseIpconfig(args: readonly string[]): Result<HostCommand, ParseError> {
  if (args.length === 0) return ok({ kind: 'ipconfig', all: false });
  const [first, ...rest] = args.map(flag);
  if (first === 'all' && rest.length === 0) return ok({ kind: 'ipconfig', all: true });
  if (first === '?') return err(IPCONFIG_USAGE);
  return err(['Error: unrecognized or incomplete command line.', ...IPCONFIG_USAGE]);
}

function parseArp(args: readonly string[]): Result<HostCommand, ParseError> {
  const [first, ...rest] = args;
  const option = first === undefined ? undefined : flag(first);
  if ((option === 'a' || option === 'g') && rest.length === 0) return ok({ kind: 'arp-show' });
  if (option === 'd' && (rest.length === 0 || (rest.length === 1 && rest[0] === '*'))) {
    return ok({ kind: 'arp-clear' });
  }
  return err(ARP_USAGE);
}

export function parseCommand(line: string): Result<HostCommand, ParseError> {
  const [name, ...args] = line.trim().split(/\s+/).filter(Boolean);
  if (name === undefined) return ok({ kind: 'empty' });
  switch (name.toLowerCase()) {
    case 'ping':
      return parsePing(args);
    case 'ipconfig':
      return parseIpconfig(args);
    case 'arp':
      return parseArp(args);
    case 'help':
      return ok({ kind: 'help' });
    case 'cls':
      return ok({ kind: 'cls' });
    default:
      return err(['Invalid Command.']);
  }
}
