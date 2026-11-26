import { describe, expect, it } from 'vitest';
import { buildOffice } from '@/features/inspector/testing';
import { Ipv4Address, Ipv6Address, MacAddress, PortId } from '@/model';
import type { PingReply, TraceProbe } from './backend';
import {
  formatArp,
  formatIpconfig,
  formatIpv6config,
  formatReply,
  pingHeader,
  pingSummary,
  tracertLines,
  type HostDevice,
} from './format';

const ip = (text: string) => Ipv4Address.parse(text);
const ip6 = (text: string) => Ipv6Address.parse(text);

/** PC1's link-local address, from its MAC fe:a8:41:78:49:8f by EUI-64. */
const PC1_LINK_LOCAL = 'FE80::FCA8:41FF:FE78:498F';

function pc1(): HostDevice {
  const { pc } = buildOffice();
  if (pc.kind !== 'pc') throw new Error('PC1 is not a PC');
  return pc;
}

describe('formatIpconfig', () => {
  it('shows the static address, mask and gateway', () => {
    expect(formatIpconfig(pc1(), true, false)).toEqual([
      '',
      'Ethernet adapter FastEthernet0:',
      '',
      '   Connection-specific DNS Suffix  . :',
      `   Link-local IPv6 Address . . . . . : ${PC1_LINK_LOCAL}`,
      '   IPv6 Address. . . . . . . . . . . : ::',
      '   IPv4 Address. . . . . . . . . . . : 192.168.1.10',
      '   Subnet Mask . . . . . . . . . . . : 255.255.255.0',
      '   Default Gateway . . . . . . . . . : ::',
      '                                       192.168.1.1',
      '',
    ]);
  });

  it('shows a static IPv6 address and gateway in upper case, without the prefix length', () => {
    const device = withIpv6({
      mode: 'static',
      address: { address: ip6('2001:db8:1::10'), prefixLength: 64 },
      gateway: ip6('fe80::1'),
    });
    expect(formatIpconfig(device, true, false).slice(4, 10)).toEqual([
      `   Link-local IPv6 Address . . . . . : ${PC1_LINK_LOCAL}`,
      '   IPv6 Address. . . . . . . . . . . : 2001:DB8:1::10',
      '   IPv4 Address. . . . . . . . . . . : 192.168.1.10',
      '   Subnet Mask . . . . . . . . . . . : 255.255.255.0',
      '   Default Gateway . . . . . . . . . : FE80::1',
      '                                       192.168.1.1',
    ]);
  });

  it('shows the live IPv6 the simulation reports over the config', () => {
    const live = {
      addressing: { kind: 'unassigned' as const },
      dateOf: (time: number) => new Date(time),
      ipv6: {
        linkLocal: ip6('fe80::fca8:41ff:fe78:498f'),
        address: { address: ip6('2001:db8:1:0:fca8:41ff:fe78:498f'), prefixLength: 64 },
        gateway: ip6('fe80::1'),
      },
    };
    const lines = formatIpconfig(withIpv6({ mode: 'auto' }), true, false, live);
    expect(lines).toContain(
      '   IPv6 Address. . . . . . . . . . . : 2001:DB8:1:0:FCA8:41FF:FE78:498F',
    );
    expect(lines.slice(-3)).toEqual([
      '   Default Gateway . . . . . . . . . : FE80::1',
      '                                       0.0.0.0',
      '',
    ]);
  });

  it('adds the host name, MAC, DHCP state and DNS server with /all', () => {
    const device = pc1();
    const mac = device.ports[0]?.kind === 'serial' ? '' : device.ports[0]!.mac;
    expect(formatIpconfig(device, true, true)).toEqual([
      '',
      '   Host Name . . . . . . . . . . . . : PC1',
      '',
      'Ethernet adapter FastEthernet0:',
      '',
      '   Connection-specific DNS Suffix  . :',
      `   Physical Address. . . . . . . . . : ${mac.replaceAll(':', '-').toUpperCase()}`,
      '   DHCP Enabled. . . . . . . . . . . : No',
      `   Link-local IPv6 Address . . . . . : ${PC1_LINK_LOCAL}`,
      '   IPv6 Address. . . . . . . . . . . : ::',
      '   IPv4 Address. . . . . . . . . . . : 192.168.1.10',
      '   Subnet Mask . . . . . . . . . . . : 255.255.255.0',
      '   Default Gateway . . . . . . . . . : ::',
      '                                       192.168.1.1',
      '   DNS Servers . . . . . . . . . . . : 192.168.1.53',
      '',
    ]);
  });

  it('shows 0.0.0.0 and unset gateways before an address is set', () => {
    const device = pc1();
    const bare = { ...device, config: { ...device.config, ipv4: { mode: 'static' as const } } };
    const lines = formatIpconfig(bare, true, false);
    expect(lines).toContain('   IPv4 Address. . . . . . . . . . . : 0.0.0.0');
    expect(lines.slice(-3)).toEqual([
      '   Default Gateway . . . . . . . . . : ::',
      '                                       0.0.0.0',
      '',
    ]);
  });

  it('reports a missing cable instead of the address', () => {
    const lines = formatIpconfig(pc1(), false, false);
    expect(lines).toContain('   Media State . . . . . . . . . . . : Media disconnected');
    expect(lines.join('\n')).not.toContain('192.168.1.10');
  });
});

function withIpv6(ipv6: HostDevice['config']['ipv6']): HostDevice {
  const device = pc1();
  return { ...device, config: { ...device.config, ipv6 } };
}

describe('formatIpv6config', () => {
  const statik = withIpv6({
    mode: 'static',
    address: { address: ip6('2001:db8:1::10'), prefixLength: 64 },
    gateway: ip6('2001:db8:1::1'),
  });

  it('shows the link-local address, the address with its prefix length, and the gateway', () => {
    expect(formatIpv6config(statik, true, false)).toEqual([
      '',
      'Ethernet adapter FastEthernet0:',
      '',
      '   Connection-specific DNS Suffix  . :',
      `   Link-local IPv6 Address . . . . . : ${PC1_LINK_LOCAL}`,
      '   IPv6 Address. . . . . . . . . . . : 2001:DB8:1::10/64',
      '   Default Gateway . . . . . . . . . : 2001:DB8:1::1',
      '',
    ]);
  });

  it('adds the MAC and DNS servers with /all', () => {
    expect(formatIpv6config(statik, true, true)).toEqual([
      '',
      'Ethernet adapter FastEthernet0:',
      '',
      '   Connection-specific DNS Suffix  . :',
      '   Physical Address. . . . . . . . . : FE-A8-41-78-49-8F',
      `   Link-local IPv6 Address . . . . . : ${PC1_LINK_LOCAL}`,
      '   IPv6 Address. . . . . . . . . . . : 2001:DB8:1::10/64',
      '   Default Gateway . . . . . . . . . : 2001:DB8:1::1',
      '   DNS Servers . . . . . . . . . . . : ::',
      '',
    ]);
  });

  it('shows :: for an address and gateway the host does not have', () => {
    expect(formatIpv6config(pc1(), true, false).slice(-3)).toEqual([
      '   IPv6 Address. . . . . . . . . . . : ::',
      '   Default Gateway . . . . . . . . . : ::',
      '',
    ]);
  });

  it('reports a missing cable instead of the addresses', () => {
    const lines = formatIpv6config(statik, false, false);
    expect(lines).toContain('   Media State . . . . . . . . . . . : Media disconnected');
    expect(lines.join('\n')).not.toContain('2001:DB8');
  });
});

describe('formatArp', () => {
  it('lists learned entries under the host interface, without its own', () => {
    const entries = [
      {
        kind: 'interface' as const,
        address: ip('192.168.1.10'),
        mac: MacAddress.parse('02:00:00:00:00:0a'),
        interface: PortId.parse('FastEthernet0'),
      },
      {
        kind: 'dynamic' as const,
        address: ip('192.168.1.1'),
        mac: MacAddress.parse('00:d0:ba:01:02:03'),
        interface: PortId.parse('FastEthernet0'),
        ageMs: 1200,
      },
    ];
    expect(formatArp(ip('192.168.1.10'), entries)).toEqual([
      '',
      'Interface: 192.168.1.10 --- 0x2',
      '  Internet Address      Physical Address      Type',
      '  192.168.1.1           00-D0-BA-01-02-03     dynamic',
      '',
    ]);
  });

  it('says so when the cache is empty', () => {
    expect(formatArp(ip('192.168.1.10'), [])).toEqual(['No ARP Entries Found.', '']);
  });
});

describe('ping lines', () => {
  const reply = (timeMs: number): PingReply => ({
    kind: 'reply',
    seq: 1,
    from: ip('10.0.0.2'),
    bytes: 32,
    timeMs,
    ttl: 128,
  });

  it('prints each answer as Windows does', () => {
    expect(formatReply(reply(1))).toBe('Reply from 10.0.0.2: bytes=32 time=1ms TTL=128');
    expect(formatReply(reply(0))).toBe('Reply from 10.0.0.2: bytes=32 time<1ms TTL=128');
    expect(formatReply({ kind: 'timeout', seq: 1 })).toBe('Request timed out.');
    expect(formatReply({ kind: 'unreachable', seq: 1, from: ip('10.0.0.1'), code: 'host' })).toBe(
      'Reply from 10.0.0.1: Destination host unreachable.',
    );
    expect(
      formatReply({ kind: 'unreachable', seq: 1, from: ip('10.0.0.1'), code: 'network' }),
    ).toBe('Reply from 10.0.0.1: Destination net unreachable.');
    expect(formatReply({ kind: 'ttl-expired', seq: 1, from: ip('10.0.0.254') })).toBe(
      'Reply from 10.0.0.254: TTL expired in transit.',
    );
  });

  it('sums up replies with round-trip times', () => {
    expect(
      pingSummary(ip('10.0.0.2'), [reply(1), reply(0), { kind: 'timeout', seq: 3 }, reply(5)]),
    ).toEqual([
      '',
      'Ping statistics for 10.0.0.2:',
      '    Packets: Sent = 4, Received = 3, Lost = 1 (25% loss),',
      'Approximate round trip times in milli-seconds:',
      '    Minimum = 0ms, Maximum = 5ms, Average = 2ms',
    ]);
  });

  it('counts unreachable as lost and leaves out times when nothing came back', () => {
    const unreachable: PingReply = {
      kind: 'unreachable',
      seq: 1,
      from: ip('10.0.0.1'),
      code: 'host',
    };
    expect(pingSummary(ip('10.0.0.2'), [unreachable, { kind: 'timeout', seq: 2 }])).toEqual([
      '',
      'Ping statistics for 10.0.0.2:',
      '    Packets: Sent = 2, Received = 0, Lost = 2 (100% loss),',
    ]);
  });
});

describe('IPv6 ping and tracert lines', () => {
  const target = ip6('2001:db8:1::2');
  const reply: PingReply = { kind: 'reply', seq: 1, from: target, bytes: 32, timeMs: 0, ttl: 255 };

  it('repeats the target as typed, then prints replies and statistics in upper case', () => {
    expect(pingHeader(target)).toEqual(['', 'Pinging 2001:db8:1::2 with 32 bytes of data:', '']);
    expect(formatReply(reply)).toBe('Reply from 2001:DB8:1::2: bytes=32 time<1ms TTL=255');
    expect(pingSummary(target, [reply]).slice(0, 2)).toEqual([
      '',
      'Ping statistics for 2001:DB8:1::2:',
    ]);
  });

  it('reports every IPv6 unreachable as Destination host unreachable', () => {
    const from = ip6('2001:db8:3::1');
    expect(formatReply({ kind: 'unreachable', seq: 1, from, code: 'network' })).toBe(
      'Reply from 2001:DB8:3::1: Destination host unreachable.',
    );
  });

  it('prints hop addresses in upper case, in the usual columns', () => {
    const lines = tracertLines(1);
    const hop: TraceProbe = {
      kind: 'ttl-expired',
      hop: 1,
      probe: 1,
      from: ip6('2001:db8:1:1::1'),
      timeMs: 0,
    };
    expect(lines.next(hop)).toBe('  1    <1 ms  2001:DB8:1:1::1\n');
    expect(
      lines.next({
        kind: 'reply',
        hop: 2,
        probe: 1,
        from: ip6('2001:db8:1:4::a'),
        timeMs: 12,
        ttl: 62,
      }),
    ).toBe('  2    12 ms  2001:DB8:1:4::A\n');
  });
});
