import { describe, expect, it } from 'vitest';
import { buildOffice } from '@/features/inspector/testing';
import { Ipv4Address, MacAddress, PortId } from '@/model';
import type { PingReply } from './backend';
import { formatArp, formatIpconfig, formatReply, pingSummary, type HostDevice } from './format';

const ip = (text: string) => Ipv4Address.parse(text);

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
      '   IPv4 Address. . . . . . . . . . . : 192.168.1.10',
      '   Subnet Mask . . . . . . . . . . . : 255.255.255.0',
      '   Default Gateway . . . . . . . . . : 192.168.1.1',
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
      '   IPv4 Address. . . . . . . . . . . : 192.168.1.10',
      '   Subnet Mask . . . . . . . . . . . : 255.255.255.0',
      '   Default Gateway . . . . . . . . . : 192.168.1.1',
      '   DNS Servers . . . . . . . . . . . : 192.168.1.53',
      '',
    ]);
  });

  it('shows 0.0.0.0 and an empty gateway before an address is set', () => {
    const device = pc1();
    const bare = { ...device, config: { ...device.config, ipv4: { mode: 'static' as const } } };
    expect(formatIpconfig(bare, true, false)).toContain(
      '   IPv4 Address. . . . . . . . . . . : 0.0.0.0',
    );
    expect(formatIpconfig(bare, true, false)).toContain('   Default Gateway . . . . . . . . . :');
  });

  it('reports a missing cable instead of the address', () => {
    const lines = formatIpconfig(pc1(), false, false);
    expect(lines).toContain('   Media State . . . . . . . . . . . : Media disconnected');
    expect(lines.join('\n')).not.toContain('192.168.1.10');
  });
});

describe('formatArp', () => {
  it('lists learned entries under the host interface, without its own', () => {
    const entries = [
      {
        kind: 'interface' as const,
        address: ip('192.168.1.10'),
        mac: MacAddress.parse('02:00:00:00:00:0a'),
        port: PortId.parse('FastEthernet0'),
      },
      {
        kind: 'dynamic' as const,
        address: ip('192.168.1.1'),
        mac: MacAddress.parse('00:d0:ba:01:02:03'),
        port: PortId.parse('FastEthernet0'),
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
