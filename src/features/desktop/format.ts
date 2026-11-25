import {
  formatSubnetMask,
  type Device,
  type Ipv4Address,
  type MacAddress,
  type Port,
} from '@/model';
import type { ArpTableEntry, PingReply, TraceProbe } from './backend';

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

const DNS_SUFFIX = '   Connection-specific DNS Suffix  . :';

/** `ipconfig`, and with `all`, `ipconfig /all`. `connected` is whether a cable is plugged in. */
export function formatIpconfig(device: HostDevice, connected: boolean, all: boolean): string[] {
  const port = addressPort(device);
  if (!port) return ['', 'No network adapters.', ''];
  const { ipv4 } = device.config;
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
  const address = ipv4.mode === 'static' ? ipv4.address : undefined;
  const gateway = ipv4.mode === 'static' ? ipv4.gateway : undefined;
  const dns = ipv4.mode === 'static' ? ipv4.dns : undefined;
  return [
    ...head,
    ...adapter,
    DNS_SUFFIX,
    ...hardware,
    entry('IPv4 Address', address?.address ?? '0.0.0.0'),
    entry('Subnet Mask', address ? formatSubnetMask(address.prefixLength) : '0.0.0.0'),
    entry('Default Gateway', gateway),
    ...(all ? [entry('DNS Servers', dns)] : []),
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

export function formatReply(reply: PingReply): string {
  switch (reply.kind) {
    case 'reply': {
      const time = reply.timeMs < 1 ? '<1ms' : `=${Math.round(reply.timeMs)}ms`;
      return `Reply from ${reply.from}: bytes=${reply.bytes} time${time} TTL=${reply.ttl}`;
    }
    case 'timeout':
      return 'Request timed out.';
    case 'unreachable': {
      const what = reply.code === 'network' ? 'net' : 'host';
      return `Reply from ${reply.from}: Destination ${what} unreachable.`;
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

const unreachable = (code: 'network' | 'host') => (code === 'network' ? 'net' : 'host');

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
