import { err, Ipv4Address, ok, type Result } from '@/model';

/** A Command Prompt line, parsed. */
export type HostCommand =
  | { kind: 'empty' }
  /** `count` is Infinity for `ping -t`, which runs until Ctrl+C. */
  | { kind: 'ping'; target: Ipv4Address; count: number }
  | { kind: 'tracert'; target: Ipv4Address; maxHops: number; timeoutMs: number }
  | { kind: 'ipconfig'; all: boolean }
  | { kind: 'arp-show' }
  /** Without an address, every entry. */
  | { kind: 'arp-clear'; address?: Ipv4Address }
  | { kind: 'help' }
  | { kind: 'cls' };

/** A line that does not parse, as the lines to print instead. */
export type ParseError = readonly string[];

export const DEFAULT_PING_COUNT = 4;
const MAX_PING_COUNT = 4294967295;

/** Windows tracert gives up after 30 hops and waits 4 seconds for each reply. */
export const TRACERT_DEFAULTS = { maxHops: 30, timeoutMs: 4000 };
const MAX_HOPS = 255;
const MAX_TIMEOUT_MS = 4294967295;

export const PING_USAGE = [
  '',
  'Usage: ping [-t] [-n count] target_name',
  '',
  'Options:',
  '    -t             Ping the specified host until stopped.',
  '                   To stop - type Control-C.',
  '    -n count       Number of echo requests to send.',
  '',
];

export const TRACERT_USAGE = [
  '',
  'Usage: tracert [-d] [-h maximum_hops] [-w timeout] target_name',
  '',
  'Options:',
  '    -d                 Do not resolve addresses to hostnames.',
  '    -h maximum_hops    Maximum number of hops to search for target.',
  '    -w timeout         Wait timeout milliseconds for each reply.',
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
  'ARP -d [inet_addr]',
  '',
  '  -a            Displays current ARP entries.',
  '  -d            Deletes the host specified by inet_addr, or all hosts without',
  '                one. inet_addr may be wildcarded with * to delete all hosts.',
  '',
];

export const HELP = [
  '',
  'Available commands:',
  '',
  '  arp -a          Show the ARP cache: IP addresses this host has resolved to MACs.',
  '  arp -d [ip]     Clear the ARP cache, or one address in it.',
  '  cls             Clear the screen.',
  '  help            Show this list.',
  '  ipconfig        Show the IP address, subnet mask and default gateway.',
  '  ipconfig /all   Also show the MAC address, DHCP and DNS settings.',
  '  ping <ip>       Send 4 echo requests. -n <count> sends more or fewer, -t until Ctrl+C.',
  '  tracert <ip>    List the routers on the way to an address, hop by hop.',
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
      const value = optionValue(args, ++i, word, MAX_PING_COUNT);
      if (!value.ok) return value;
      // -t wins over -n, wherever each comes.
      if (count !== Infinity) count = value.value;
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

/** Reads the value after option `word` at `args[at]` as a whole number in [1, max]. */
function optionValue(
  args: readonly string[],
  at: number,
  word: string,
  max: number,
): Result<number, ParseError> {
  const value = args[at];
  if (value === undefined) return err([`Value must be supplied for option ${word}.`]);
  const n = /^\d+$/.test(value) ? Number(value) : NaN;
  if (!(n >= 1 && n <= max)) {
    return err([`Bad value for option ${word}, valid range is from 1 to ${max}.`]);
  }
  return ok(n);
}

function parseTracert(args: readonly string[]): Result<HostCommand, ParseError> {
  let { maxHops, timeoutMs } = TRACERT_DEFAULTS;
  let target: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const word = args[i]!;
    const option = flag(word);
    if (option === undefined) {
      if (target !== undefined) return err([`Bad parameter ${word}.`]);
      target = word;
    } else if (option === 'd') {
      // There are no host names to resolve.
    } else if (option === 'h' || option === 'w') {
      const value = optionValue(args, ++i, word, option === 'h' ? MAX_HOPS : MAX_TIMEOUT_MS);
      if (!value.ok) return value;
      if (option === 'h') maxHops = value.value;
      else timeoutMs = value.value;
    } else {
      return err(TRACERT_USAGE);
    }
  }
  if (target === undefined) return err(TRACERT_USAGE);
  const address = Ipv4Address.safeParse(target);
  if (!address.success) return err([`Unable to resolve target system name ${target}.`]);
  return ok({ kind: 'tracert', target: address.data, maxHops, timeoutMs });
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
  if (option !== 'd' || rest.length > 1) return err(ARP_USAGE);
  const [host] = rest;
  if (host === undefined || host === '*') return ok({ kind: 'arp-clear' });
  const address = Ipv4Address.safeParse(host);
  return address.success ? ok({ kind: 'arp-clear', address: address.data }) : err(ARP_USAGE);
}

export function parseCommand(line: string): Result<HostCommand, ParseError> {
  const [name, ...args] = line.trim().split(/\s+/).filter(Boolean);
  if (name === undefined) return ok({ kind: 'empty' });
  switch (name.toLowerCase()) {
    case 'ping':
      return parsePing(args);
    case 'tracert':
      return parseTracert(args);
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
