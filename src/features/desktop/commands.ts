import { DomainName, err, Ipv4Address, ok, type Result } from '@/model';
import { readIpv6, type IpAddress } from '@/model/ipv6';

/** A Command Prompt line, parsed. */
export type HostCommand =
  | { kind: 'empty' }
  /** `count` is Infinity for `ping -t`, which runs until Ctrl+C. */
  | { kind: 'ping'; target: IpAddress; count: number }
  | { kind: 'tracert'; target: IpAddress; maxHops: number; timeoutMs: number }
  | { kind: 'ipconfig'; all: boolean }
  | { kind: 'ipv6config'; all: boolean }
  | { kind: 'ipconfig-release' }
  | { kind: 'ipconfig-renew' }
  | { kind: 'arp-show' }
  /** Without an address, every entry. */
  | { kind: 'arp-clear'; address?: Ipv4Address }
  /** Without a server, the host's own DNS server. */
  | { kind: 'nslookup'; name: DomainName; server?: Ipv4Address }
  /** `telnet <ip>` or `ssh -l <user> <ip>`: a session on a router or switch's vty line. */
  | { kind: 'remote'; protocol: 'telnet'; target: Ipv4Address }
  | { kind: 'remote'; protocol: 'ssh'; target: Ipv4Address; user: string }
  /** `ftp <ip>`: an FTP session at an `ftp>` prompt. */
  | { kind: 'ftp'; target: Ipv4Address }
  | { kind: 'dir' }
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
  '    ipconfig [/all | /release | /renew]',
  '',
  'Options:',
  '    /all         Display full configuration information.',
  '    /release     Release the IPv4 address for the adapter.',
  '    /renew       Renew the IPv4 address for the adapter.',
  '',
];

const IPV6CONFIG_USAGE = [
  '',
  'USAGE:',
  '    ipv6config [/all]',
  '',
  'Options:',
  '    /all         Display full configuration information.',
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

export const NSLOOKUP_USAGE = [
  '',
  'Usage:',
  '   nslookup name [server]',
  '',
  '   Looks up the IPv4 address of name, asking server or else the default DNS server.',
  '',
];

const TELNET_USAGE = ['', 'Usage: telnet target', ''];
const FTP_USAGE = ['', 'Usage: ftp target', ''];
const SSH_USAGE = ['', 'Usage: SSH -l username target', ''];

export const HELP = [
  '',
  'Available commands:',
  '',
  '  arp -a              Show the ARP cache: IP addresses this host has resolved to MACs.',
  '  arp -d [ip]         Clear the ARP cache, or one address in it.',
  '  cls                 Clear the screen.',
  '  dir                 List the files on this computer.',
  '  ftp <ip>            Log in to an FTP server to put, get, list, rename and delete files.',
  '  help                Show this list.',
  '  ipconfig            Show the IP address, subnet mask and default gateway.',
  '  ipconfig /all       Also show the MAC address, DHCP lease and DNS settings.',
  '  ipconfig /renew     Ask the DHCP server for an address, or to extend the lease.',
  '  ipconfig /release   Give the DHCP lease back.',
  '  ipv6config          Show the IPv6 link-local and global addresses and the gateway.',
  '  ipv6config /all     Also show the MAC address and DNS servers.',
  "  nslookup <name>     Ask the DNS server for a name's address. Add an IP to ask that server.",
  '  ping <ip>           Send 4 echo requests. -n <count> sends more or fewer, -t until Ctrl+C.',
  '  ssh -l <user> <ip>  Log in to a router or switch over SSH.',
  '  telnet <ip>         Log in to a router or switch over Telnet.',
  '  tracert <ip>        List the routers on the way to an address, hop by hop.',
  '',
  'Up and Down recall earlier commands. Ctrl+C stops a running command.',
  '',
];

/** A ping or tracert target: an IPv4 address, or an IPv6 address in any valid form. */
function readTarget(text: string): IpAddress | undefined {
  const ipv4 = Ipv4Address.safeParse(text);
  return ipv4.success ? ipv4.data : readIpv6(text);
}

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
  const address = readTarget(target);
  if (!address) {
    return err([
      `Ping request could not find host ${target}. Please check the name and try again.`,
    ]);
  }
  return ok({ kind: 'ping', target: address, count });
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
  const address = readTarget(target);
  if (!address) return err([`Unable to resolve target system name ${target}.`]);
  return ok({ kind: 'tracert', target: address, maxHops, timeoutMs });
}

const IPCONFIG_OPTIONS: Record<string, HostCommand> = {
  all: { kind: 'ipconfig', all: true },
  release: { kind: 'ipconfig-release' },
  renew: { kind: 'ipconfig-renew' },
};

function parseIpconfig(args: readonly string[]): Result<HostCommand, ParseError> {
  if (args.length === 0) return ok({ kind: 'ipconfig', all: false });
  const [first, ...rest] = args.map(flag);
  const command = first === undefined ? undefined : IPCONFIG_OPTIONS[first];
  if (command && rest.length === 0) return ok(command);
  if (first === '?') return err(IPCONFIG_USAGE);
  return err(['Error: unrecognized or incomplete command line.', ...IPCONFIG_USAGE]);
}

function parseIpv6config(args: readonly string[]): Result<HostCommand, ParseError> {
  const options = args.map(flag);
  if (options.length === 0) return ok({ kind: 'ipv6config', all: false });
  if (options.length === 1 && options[0] === 'all') return ok({ kind: 'ipv6config', all: true });
  if (options[0] === '?') return err(IPV6CONFIG_USAGE);
  return err(['Error: unrecognized or incomplete command line.', ...IPV6CONFIG_USAGE]);
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

function parseNslookup(args: readonly string[]): Result<HostCommand, ParseError> {
  const [name, server, ...rest] = args;
  if (name === undefined || flag(name) !== undefined || rest.length > 0) return err(NSLOOKUP_USAGE);
  const domain = DomainName.safeParse(name);
  if (!domain.success) return err([`*** Invalid name: ${name}`]);
  if (server === undefined) return ok({ kind: 'nslookup', name: domain.data });
  const address = Ipv4Address.safeParse(server);
  if (!address.success) {
    return err([`*** Can't find address for server ${server}: Non-existent domain`]);
  }
  return ok({ kind: 'nslookup', name: domain.data, server: address.data });
}

function parseTelnet(args: readonly string[]): Result<HostCommand, ParseError> {
  const [target, ...rest] = args;
  if (target === undefined || rest.length > 0) return err(TELNET_USAGE);
  const address = Ipv4Address.safeParse(target);
  if (!address.success)
    return err([`% Unknown command or computer name, or unable to find computer address`]);
  return ok({ kind: 'remote', protocol: 'telnet', target: address.data });
}

function parseFtp(args: readonly string[]): Result<HostCommand, ParseError> {
  const [target, ...rest] = args;
  if (target === undefined || rest.length > 0) return err(FTP_USAGE);
  const address = Ipv4Address.safeParse(target);
  if (!address.success)
    return err([`% Unknown command or computer name, or unable to find computer address`]);
  return ok({ kind: 'ftp', target: address.data });
}

function parseSsh(args: readonly string[]): Result<HostCommand, ParseError> {
  const [option, user, target, ...rest] = args;
  if (option !== '-l' || user === undefined || target === undefined || rest.length > 0) {
    return err(SSH_USAGE);
  }
  const address = Ipv4Address.safeParse(target);
  if (!address.success)
    return err([`% Unknown command or computer name, or unable to find computer address`]);
  return ok({ kind: 'remote', protocol: 'ssh', target: address.data, user });
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
    case 'ipv6config':
      return parseIpv6config(args);
    case 'arp':
      return parseArp(args);
    case 'nslookup':
      return parseNslookup(args);
    case 'telnet':
      return parseTelnet(args);
    case 'ssh':
      return parseSsh(args);
    case 'ftp':
      return parseFtp(args);
    case 'dir':
      return ok({ kind: 'dir' });
    case 'help':
      return ok({ kind: 'help' });
    case 'cls':
      return ok({ kind: 'cls' });
    default:
      return err(['Invalid Command.']);
  }
}
