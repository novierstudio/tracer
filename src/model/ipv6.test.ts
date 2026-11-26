// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  compareIpv6,
  configuredIpv6Addresses,
  eui64Address,
  eui64Mac,
  inIpv6Prefix,
  iosIpv6,
  ipv6Enabled,
  ipv6MulticastMac,
  ipv6Network,
  isIpv6Multicast,
  isLinkLocal,
  linkLocalOf,
  readIpv6,
  readIpv6Cidr,
  solicitedNode,
} from './ipv6';
import { PortId } from './topology';
import { Ipv6Address as Ipv6AddressSchema, MacAddress } from './values';

const v6 = (text: string) => readIpv6(text)!;
const mac = (text: string) => MacAddress.parse(text);

describe('IPv6 addresses', () => {
  it.each([
    ['2001:0db8:0000:0000:0000:0000:0000:0001', '2001:db8::1'],
    ['2001:DB8::1', '2001:db8::1'],
    ['2001:db8:0:0:1:0:0:1', '2001:db8::1:0:0:1'],
    ['2001:db8:0:1:1:1:1:1', '2001:db8:0:1:1:1:1:1'],
    ['fe80:0:0:0:0201:42ff:fe5b:2c1a', 'fe80::201:42ff:fe5b:2c1a'],
    ['0:0:0:0:0:0:0:0', '::'],
    ['0:0:0:0:0:0:0:1', '::1'],
    ['1:0:0:0:0:0:0:0', '1::'],
    ['2001:db8::0:1', '2001:db8::1'],
    ['::ffff:10.0.0.1', '::ffff:a00:1'],
    ['FF02::1:FF00:1', 'ff02::1:ff00:1'],
  ])('reads %s in its canonical compressed form %s', (text, canonical) => {
    expect(readIpv6(text)).toBe(canonical);
  });

  it('compresses the first of two equally long zero runs (RFC 5952)', () => {
    expect(readIpv6('2001:0:0:1:0:0:0:1')).toBe('2001:0:0:1::1');
    expect(readIpv6('2001:db8:0:0:1:0:0:1')).toBe('2001:db8::1:0:0:1');
  });

  it.each([
    '',
    '1',
    '2001:db8',
    '2001:db8:::1',
    '2001::db8::1',
    '1:2:3:4:5:6:7:8:9',
    '1:2:3:4:5:6:7::8',
    '12345::1',
    'g::1',
    '::ffff:300.0.0.1',
    '192.168.1.1',
  ])('refuses %j', (text) => {
    expect(readIpv6(text)).toBeUndefined();
  });

  it('parses through the schema to the canonical form', () => {
    expect(Ipv6AddressSchema.parse('2001:DB8:0::1')).toBe('2001:db8::1');
    expect(Ipv6AddressSchema.safeParse('2001:db8::g').success).toBe(false);
  });

  it('prints as IOS does, in upper case', () => {
    expect(iosIpv6(v6('fe80::201:42ff:fe5b:2c1a'))).toBe('FE80::201:42FF:FE5B:2C1A');
  });

  it('reads a prefix and keeps the host bits', () => {
    expect(readIpv6Cidr('2001:DB8:1::1/64')).toEqual({
      address: '2001:db8:1::1',
      prefixLength: 64,
    });
    expect(readIpv6Cidr('2001:db8::/129')).toBeUndefined();
    expect(readIpv6Cidr('2001:db8::')).toBeUndefined();
    expect(readIpv6Cidr('2001:db8::/64/1')).toBeUndefined();
  });

  it('finds the network of a prefix and whether an address is in it', () => {
    expect(ipv6Network({ address: v6('2001:db8:1:2:3:4:5:6'), prefixLength: 64 })).toBe(
      '2001:db8:1:2::',
    );
    expect(ipv6Network({ address: v6('2001:db8:1:2::1'), prefixLength: 0 })).toBe('::');
    const prefix = { address: v6('2001:db8:1::'), prefixLength: 64 };
    expect(inIpv6Prefix(prefix, v6('2001:db8:1::abcd'))).toBe(true);
    expect(inIpv6Prefix(prefix, v6('2001:db8:2::1'))).toBe(false);
  });

  it('tells link-local and multicast addresses apart', () => {
    expect(isLinkLocal(v6('fe80::1'))).toBe(true);
    expect(isLinkLocal(v6('febf::1'))).toBe(true);
    expect(isLinkLocal(v6('fec0::1'))).toBe(false);
    expect(isIpv6Multicast(v6('ff02::1'))).toBe(true);
    expect(isIpv6Multicast(v6('2001:db8::1'))).toBe(false);
  });

  it('orders addresses numerically', () => {
    const sorted = ['fe80::1', '2001:db8::10', '2001:db8::2'].map(v6).sort(compareIpv6);
    expect(sorted).toEqual(['2001:db8::2', '2001:db8::10', 'fe80::1']);
  });
});

describe('EUI-64', () => {
  it('flips the universal/local bit and puts FF:FE in the middle', () => {
    expect(linkLocalOf(mac('00:01:42:5b:2c:1a'))).toBe('fe80::201:42ff:fe5b:2c1a');
    expect(linkLocalOf(mac('00d0.9749.c501'))).toBe('fe80::2d0:97ff:fe49:c501');
    // A locally administered MAC has the bit set, so it is cleared.
    expect(linkLocalOf(mac('02:00:00:00:00:0a'))).toBe('fe80::ff:fe00:a');
  });

  it('fills a /64 prefix with the identifier, ignoring the host bits typed', () => {
    expect(eui64Address(v6('2001:db8:acad:a::'), mac('00:d0:58:51:5e:24'))).toBe(
      '2001:db8:acad:a:2d0:58ff:fe51:5e24',
    );
    expect(eui64Address(v6('2001:db8:acad:a::1'), mac('00:d0:58:51:5e:24'))).toBe(
      '2001:db8:acad:a:2d0:58ff:fe51:5e24',
    );
  });

  it('builds a serial interface from the first Ethernet port, as IOS does', () => {
    const ports = [
      { kind: 'serial' as const, id: PortId.parse('Serial0/0/0') },
      {
        kind: 'gigabitEthernet' as const,
        id: PortId.parse('GigabitEthernet0/0'),
        mac: mac('00:d0:bc:32:7c:24'),
      },
    ];
    expect(eui64Mac(ports, 'Serial0/0/0')).toBe('00:d0:bc:32:7c:24');
    expect(eui64Mac(ports, 'GigabitEthernet0/0')).toBe('00:d0:bc:32:7c:24');
    expect(eui64Mac(ports, 'Loopback0')).toBe('00:d0:bc:32:7c:24');
  });

  it('fills in the configured eui-64 addresses', () => {
    const config = {
      addresses: [
        { cidr: { address: v6('2001:db8:1::1'), prefixLength: 64 }, eui64: false },
        { cidr: { address: v6('2001:db8:2::'), prefixLength: 64 }, eui64: true },
      ],
    };
    expect(configuredIpv6Addresses(config, mac('00:01:42:5b:2c:1a'))).toEqual([
      { address: '2001:db8:1::1', prefixLength: 64, eui64: false },
      { address: '2001:db8:2:0:201:42ff:fe5b:2c1a', prefixLength: 64, eui64: true },
    ]);
    expect(ipv6Enabled(config)).toBe(true);
    expect(ipv6Enabled({ addresses: [] })).toBe(false);
    expect(ipv6Enabled({ addresses: [], enabled: true })).toBe(true);
    expect(ipv6Enabled(undefined)).toBe(false);
  });
});

describe('IPv6 multicast', () => {
  it('derives the solicited-node group from the last 24 bits', () => {
    expect(solicitedNode(v6('2001:db8::1'))).toBe('ff02::1:ff00:1');
    expect(solicitedNode(v6('fe80::201:42ff:fe5b:2c1a'))).toBe('ff02::1:ff5b:2c1a');
  });

  it('maps a group to 33:33 and its last 32 bits', () => {
    expect(ipv6MulticastMac(v6('ff02::1'))).toBe('33:33:00:00:00:01');
    expect(ipv6MulticastMac(v6('ff02::1:ff5b:2c1a'))).toBe('33:33:ff:5b:2c:1a');
  });
});
