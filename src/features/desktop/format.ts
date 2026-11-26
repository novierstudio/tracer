import { addressOf, gatewayOf } from '@/engine/l3/hostAddress';
import type { UnreachableCode } from '@/engine/pdu';
import {
  formatSubnetMask,
  type Device,
  type Ipv4Address,
  type MacAddress,
  type Port,
} from '@/model';
import type { ArpTableEntry, DnsLookup, HostAddressing, PingReply, TraceProbe } from './backend';

export type HostDevice = Extract<Device, { kind: 'pc' | 'server' }>;

export const isHostDevice = (device: Device | undefined): device is HostDevice =>
  device?.kind === 'pc' || device?.kind === 'server';

export type EthernetPort = Exclude<Port, { kind: 'serial' }>;

/** The host's one address belongs to its first Ethernet port, as in the inspector. */
export function addressPort(device: HostDevice): EthernetPort | undefined {
  return device.ports.find((port): port is EthernetPort => port.kind !== 'serial');
}

/** `02:00:00:00:00:0a` → `02-00-00-00-00-0A`, as Windows prints a MAC. */
export const windowsMac = (mac: MacAddress) => mac.replaceAll(':', '-').toUpperCase();

/** `IPv4 Address. . . . : 10.0.0.1`: dots on even columns after the label, then the value. */
function entry(label: string, value = ''): string {
  let leader = label;
  while (leader.length < 34) leader += leader.length % 2 === 0 ? '.' : ' ';
  return `   ${leader}: ${value}`.trimEnd();
}

/** A value on the line under an `entry`, as Windows lists a second DNS server. */
const continued = (value: string) => `${' '.repeat(39)}${value}`;

const DNS_SUFFIX = '   Connection-specific DNS Suffix  . :';

/**
 * What the host's config alone says its addressing is. Only the simulation knows a DHCP host's,
 * so without it a DHCP host has none.
 */
export function configAddressing(device: HostDevice): HostAddressing {
  const { ipv4 } = device.config;
  if (ipv4.mode === 'dhcp') return { kind: 'unassigned' };
  const { address, gateway, dns } = ipv4;
  return { kind: 'static', address, gateway, dns: dns ? [dns] : [] };
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** `Thursday, November 26, 2026 9:41:07 AM`, as Windows writes a lease's times, in local time. */
export function windowsDate(date: Date): string {
  const hours = date.getHours();
  const pad = (n: number) => String(n).padStart(2, '0');
  const time = `${hours % 12 === 0 ? 12 : hours % 12}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${hours < 12 ? 'AM' : 'PM'}`;
  return `${DAYS[date.getDay()]}, ${MONTHS[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()} ${time}`;
}

/** A host's live addressing for `ipconfig`, and the date each simulated time falls on. */
export type IpconfigView = {
  readonly addressing: HostAddressing;
  readonly dateOf: (time: number) => Date;
};

/**
 * `ipconfig`, and with `all`, `ipconfig /all`. `connected` is whether a cable is plugged in.
 * `live` is what the simulation says the host's addressing is; without it, the config's.
 */
export function formatIpconfig(
  device: HostDevice,
  connected: boolean,
  all: boolean,
  live?: IpconfigView,
): string[] {
  const port = addressPort(device);
  if (!port) return ['', 'No network adapters.', ''];
  const { ipv4 } = device.config;
  const addressing = live?.addressing ?? configAddressing(device);
  const head = all ? ['', entry('Host Name', device.config.hostname)] : [];
  const hardware = all
    ? [
        entry('Physical Address', windowsMac(port.mac)),
        entry('DHCP Enabled', ipv4.mode === 'dhcp' ? 'Yes' : 'No'),
      ]
    : [];
  const adapter = ['', `Ethernet adapter ${port.id}:`, ''];
  if (!connected) {
    return [
      ...head,
      ...adapter,
      entry('Media State', 'Media disconnected'),
      DNS_SUFFIX,
      ...hardware,
      '',
    ];
  }
  const address = addressOf(addressing);
  const [dns, ...moreDns] =
    addressing.kind === 'static' || addressing.kind === 'leased' ? addressing.dns : [];
  const lease =
    all && addressing.kind === 'leased' && live
      ? [
          entry('Lease Obtained', windowsDate(live.dateOf(addressing.obtainedAt))),
          entry(
            'Lease Expires',
            addressing.expiresAt === undefined
              ? 'Never'
              : windowsDate(live.dateOf(addressing.expiresAt)),
          ),
        ]
      : [];
  return [
    ...head,
    ...adapter,
    DNS_SUFFIX,
    ...hardware,
    addressing.kind === 'autoconfigured'
      ? entry('Autoconfiguration IPv4 Address', addressing.address.address)
      : entry('IPv4 Address', address?.address ?? '0.0.0.0'),
    entry('Subnet Mask', address ? formatSubnetMask(address.prefixLength) : '0.0.0.0'),
    ...lease,
    entry('Default Gateway', gatewayOf(addressing)),
    ...(all && addressing.kind === 'leased' ? [entry('DHCP Server', addressing.server)] : []),
    ...(all ? [entry('DNS Servers', dns), ...moreDns.map(continued)] : []),
    '',
  ];
}

/** `arp -a`: the addresses the host has learned, or Windows' line for an empty cache. */
export function formatArp(
  address: Ipv4Address | undefined,
  entries: readonly ArpTableEntry[],
): string[] {
  const learned = entries.filter((entry) => entry.kind === 'dynamic');
  if (!address || learned.length === 0) return ['No ARP Entries Found.', ''];
  const row = (a: string, b: string, c: string) => `  ${a.padEnd(22)}${b.padEnd(22)}${c}`;
  return [
    '',
    `Interface: ${address} --- 0x2`,
    row('Internet Address', 'Physical Address', 'Type'),
    ...learned.map((entry) => row(entry.address, windowsMac(entry.mac), 'dynamic')),
    '',
  ];
}

export const pingHeader = (target: Ipv4Address) => [
  '',
  `Pinging ${target} with 32 bytes of data:`,
  '',
];

/** Windows names a network or a host. Like Packet Tracer, it reports an access list's denial as host. */
const unreachable = (code: UnreachableCode) => (code === 'network' ? 'net' : 'host');

export function formatReply(reply: PingReply): string {
  switch (reply.kind) {
    case 'reply': {
      const time = reply.timeMs < 1 ? '<1ms' : `=${Math.round(reply.timeMs)}ms`;
      return `Reply from ${reply.from}: bytes=${reply.bytes} time${time} TTL=${reply.ttl}`;
    }
    case 'timeout':
      return 'Request timed out.';
    case 'unreachable': {
      return `Reply from ${reply.from}: Destination ${unreachable(reply.code)} unreachable.`;
    }
    case 'ttl-expired':
      return `Reply from ${reply.from}: TTL expired in transit.`;
  }
}

/**
 * The statistics block. As in the engine's summary and unlike Windows, only echo replies count as
 * received, so the numbers say what a student means by "it worked".
 */
export function pingSummary(target: Ipv4Address, replies: readonly PingReply[]): string[] {
  const times = replies.flatMap((r) => (r.kind === 'reply' ? [Math.round(r.timeMs)] : []));
  const sent = replies.length;
  const lost = sent - times.length;
  const loss = sent === 0 ? 0 : Math.floor((lost * 100) / sent);
  const lines = [
    '',
    `Ping statistics for ${target}:`,
    `    Packets: Sent = ${sent}, Received = ${times.length}, Lost = ${lost} (${loss}% loss),`,
  ];
  if (times.length === 0) return lines;
  const total = times.reduce((sum, t) => sum + t, 0);
  return [
    ...lines,
    'Approximate round trip times in milli-seconds:',
    `    Minimum = ${Math.min(...times)}ms, Maximum = ${Math.max(...times)}ms, Average = ${Math.floor(total / times.length)}ms`,
  ];
}

export const tracertHeader = (target: Ipv4Address, maxHops: number) => [
  '',
  `Tracing route to ${target} over a maximum of ${maxHops} hops`,
  '',
];

/**
 * Windows tracert's hop lines, a column at a time as each probe settles: the hop number, a 9
 * character column per probe (`<1 ms`, `4 ms` or `*`), then who answered, or `Request timed out.`
 * when nobody did. A Destination Unreachable ends the line, and the trace, with the router's report.
 */
export function tracertLines(probesPerHop: number) {
  let open = false;
  let from: Ipv4Address | undefined;
  return {
    /** The text for one probe. A line ends with `\n`. */
    next(probe: TraceProbe): string {
      let text = '';
      if (!open) {
        text = String(probe.hop).padStart(3);
        open = true;
        from = undefined;
      }
      if (probe.kind === 'unreachable') {
        open = false;
        return `${text}  ${probe.from}  reports: Destination ${unreachable(probe.code)} unreachable.\n`;
      }
      if (probe.kind === 'timeout') {
        text += '     *   ';
      } else {
        const time = probe.timeMs < 1 ? '<1' : String(Math.round(probe.timeMs));
        text += `  ${time.padStart(4)} ms`;
        from = probe.from;
      }
      if (probe.probe < probesPerHop) return text;
      open = false;
      return `${text}  ${from ?? 'Request timed out.'}\n`;
    },
    /** Ends a line that a Ctrl+C cut short. */
    close: () => (open ? '\n' : ''),
  };
}

/** Windows names the server by its PTR record, which Tracer's DNS servers do not keep. */
const serverLines = (server: Ipv4Address) => ['Server:  UnKnown', `Address:  ${server}`, ''];

/** `nslookup`'s report for a lookup's outcome, as Windows words it. */
export function formatNslookup(lookup: DnsLookup): string[] {
  switch (lookup.kind) {
    case 'answer':
      return [
        ...serverLines(lookup.server),
        `Name:    ${lookup.name}`,
        `Address:  ${lookup.address}`,
        '',
      ];
    case 'not-found':
      return [
        ...serverLines(lookup.server),
        `*** UnKnown can't find ${lookup.name}: Non-existent domain`,
        '',
      ];
    case 'timeout':
      return [
        ...serverLines(lookup.server),
        'DNS request timed out.',
        '    timeout was 2 seconds.',
        '*** Request to UnKnown timed-out',
        '',
      ];
    case 'no-server':
      return ['*** Default servers are not available', ''];
    case 'cancelled':
      return ['*** Request cancelled', ''];
  }
}
