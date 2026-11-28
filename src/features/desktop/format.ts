import { addressOf, gatewayOf } from '@/engine/l3/hostAddress';
import type { UnreachableCode } from '@/engine/pdu';
import {
  associations,
  formatSubnetMask,
  linkAt,
  type Device,
  type Ipv4Address,
  type MacAddress,
  type Port,
  type Topology,
} from '@/model';
import {
  iosAddress,
  iosIpv6,
  iosIpv6Cidr,
  isIpv6,
  linkLocalOf,
  type IpAddress,
  type Ipv6Address,
  type Ipv6Cidr,
} from '@/model/ipv6';
import type {
  ArpTableEntry,
  DnsLookup,
  HostAddressing,
  Ipv6Status,
  PingReply,
  TraceProbe,
} from './backend';

export type HostDevice = Extract<Device, { kind: 'pc' | 'server' }>;

export const isHostDevice = (device: Device | undefined): device is HostDevice =>
  device?.kind === 'pc' || device?.kind === 'server';

export type EthernetPort = Exclude<Port, { kind: 'serial' }>;

/** The host's one address belongs to its first Ethernet port, as in the inspector. */
export function addressPort(device: HostDevice): EthernetPort | undefined {
  return device.ports.find((port): port is EthernetPort => port.kind !== 'serial');
}

/** Whether the host's network card is connected: a cable in its port, or its radio associated. */
export function nicConnected(topology: Topology, device: HostDevice): boolean {
  const port = addressPort(device);
  if (!port) return false;
  if (port.kind !== 'wireless') return !!linkAt(topology, { device: device.id, port: port.id });
  return associations(Object.values(topology.devices)).some((link) => link.a.device === device.id);
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

/** A host's IPv6 as `ipconfig` and `ipv6config` show it. */
export type HostIpv6View = {
  readonly linkLocal: Ipv6Address;
  readonly address?: Ipv6Cidr;
  readonly gateway?: Ipv6Address;
};

/** What the host's config alone says its IPv6 is: a SLAAC host has its link-local address only. */
export function configIpv6(device: HostDevice, port: EthernetPort): HostIpv6View {
  const { ipv6 } = device.config;
  const linkLocal = linkLocalOf(port.mac);
  if (ipv6?.mode !== 'static') return { linkLocal };
  return {
    linkLocal,
    ...(ipv6.address && { address: ipv6.address }),
    ...(ipv6.gateway && { gateway: ipv6.gateway }),
  };
}

/** The host's IPv6 as the simulation runs it: its port's addresses, and the gateway it uses. */
export function liveIpv6(status: Ipv6Status, port: EthernetPort): HostIpv6View {
  const own = status.interfaces[0];
  const [address] = own?.addresses ?? [];
  return {
    linkLocal: own?.linkLocal ?? linkLocalOf(port.mac),
    ...(address && { address }),
    ...(status.gateway && { gateway: status.gateway }),
  };
}

const UNSET_IPV6 = '::';

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

/**
 * A host's live addressing for `ipconfig`, and the date each simulated time falls on. Without
 * `ipv6`, the host's IPv6 is its config's.
 */
export type IpconfigView = {
  readonly addressing: HostAddressing;
  readonly dateOf: (time: number) => Date;
  readonly ipv6?: HostIpv6View;
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
  const ipv6 = live?.ipv6 ?? configIpv6(device, port);
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
    entry('Link-local IPv6 Address', iosIpv6(ipv6.linkLocal)),
    entry('IPv6 Address', ipv6.address ? iosIpv6(ipv6.address.address) : UNSET_IPV6),
    addressing.kind === 'autoconfigured'
      ? entry('Autoconfiguration IPv4 Address', addressing.address.address)
      : entry('IPv4 Address', address?.address ?? '0.0.0.0'),
    entry('Subnet Mask', address ? formatSubnetMask(address.prefixLength) : '0.0.0.0'),
    ...lease,
    entry('Default Gateway', ipv6.gateway ? iosIpv6(ipv6.gateway) : UNSET_IPV6),
    continued(gatewayOf(addressing) ?? '0.0.0.0'),
    ...(all && addressing.kind === 'leased' ? [entry('DHCP Server', addressing.server)] : []),
    ...(all ? [entry('DNS Servers', dns), ...moreDns.map(continued)] : []),
    '',
  ];
}

/**
 * `ipv6config`, and with `all`, `ipv6config /all`: Packet Tracer's IPv6 counterpart of
 * `ipconfig`, in the same layout. `ipv6` is the host's IPv6 now.
 */
export function formatIpv6config(
  device: HostDevice,
  connected: boolean,
  all: boolean,
  ipv6?: HostIpv6View,
): string[] {
  const port = addressPort(device);
  if (!port) return ['', 'No network adapters.', ''];
  const adapter = ['', `Ethernet adapter ${port.id}:`, ''];
  const physical = all ? [entry('Physical Address', windowsMac(port.mac))] : [];
  if (!connected) {
    return [...adapter, entry('Media State', 'Media disconnected'), DNS_SUFFIX, ...physical, ''];
  }
  const { linkLocal, address, gateway } = ipv6 ?? configIpv6(device, port);
  return [
    ...adapter,
    DNS_SUFFIX,
    ...physical,
    entry('Link-local IPv6 Address', iosIpv6(linkLocal)),
    entry('IPv6 Address', address ? iosIpv6Cidr(address) : UNSET_IPV6),
    entry('Default Gateway', gateway ? iosIpv6(gateway) : UNSET_IPV6),
    ...(all ? [entry('DNS Servers', UNSET_IPV6)] : []),
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

/** The target as typed, in canonical form: Packet Tracer upper-cases IPv6 only in what follows. */
export const pingHeader = (target: IpAddress) => [
  '',
  `Pinging ${target} with 32 bytes of data:`,
  '',
];

/**
 * Windows names a network or a host. Like Packet Tracer, it reports an access list's denial as
 * host, and every IPv6 unreachable too.
 */
const unreachable = (from: IpAddress, code: UnreachableCode) =>
  code === 'network' && !isIpv6(from) ? 'net' : 'host';

export function formatReply(reply: PingReply): string {
  switch (reply.kind) {
    case 'reply': {
      const time = reply.timeMs < 1 ? '<1ms' : `=${Math.round(reply.timeMs)}ms`;
      return `Reply from ${iosAddress(reply.from)}: bytes=${reply.bytes} time${time} TTL=${reply.ttl}`;
    }
    case 'timeout':
      return 'Request timed out.';
    case 'unreachable': {
      return `Reply from ${iosAddress(reply.from)}: Destination ${unreachable(reply.from, reply.code)} unreachable.`;
    }
    case 'ttl-expired':
      return `Reply from ${iosAddress(reply.from)}: TTL expired in transit.`;
  }
}

/**
 * The statistics block. As in the engine's summary and unlike Windows, only echo replies count as
 * received, so the numbers say what a student means by "it worked".
 */
export function pingSummary(target: IpAddress, replies: readonly PingReply[]): string[] {
  const times = replies.flatMap((r) => (r.kind === 'reply' ? [Math.round(r.timeMs)] : []));
  const sent = replies.length;
  const lost = sent - times.length;
  const loss = sent === 0 ? 0 : Math.floor((lost * 100) / sent);
  const lines = [
    '',
    `Ping statistics for ${iosAddress(target)}:`,
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

export const tracertHeader = (target: IpAddress, maxHops: number) => [
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
  let from: IpAddress | undefined;
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
        return `${text}  ${iosAddress(probe.from)}  reports: Destination ${unreachable(probe.from, probe.code)} unreachable.\n`;
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
      return `${text}  ${from ? iosAddress(from) : 'Request timed out.'}\n`;
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
