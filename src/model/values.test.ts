// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  Hostname,
  Ipv4Address,
  MacAddress,
  PrefixLength,
  SubnetMask,
  VlanId,
  formatSubnetMask,
} from './values';

describe('Ipv4Address', () => {
  it.each(['0.0.0.0', '10.0.0.1', '192.168.1.254', '255.255.255.255'])('accepts %s', (text) => {
    expect(Ipv4Address.parse(text)).toBe(text);
  });

  it.each(['256.0.0.1', '10.0.0', '010.0.0.1', '10.0.0.1 ', '', 'ten.0.0.1'])(
    'rejects %j',
    (text) => {
      expect(Ipv4Address.safeParse(text).success).toBe(false);
    },
  );
});

describe('SubnetMask', () => {
  it.each([
    ['255.255.255.0', 24],
    ['255.255.255.252', 30],
    ['255.255.0.0', 16],
    ['128.0.0.0', 1],
    ['0.0.0.0', 0],
    ['255.255.255.255', 32],
  ])('parses %s as a /%i prefix', (mask, prefix) => {
    expect(SubnetMask.parse(mask)).toBe(prefix);
  });

  it('rejects a mask whose one bits are not contiguous', () => {
    const result = SubnetMask.safeParse('255.0.255.0');

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe('Subnet mask bits must be contiguous');
  });

  it('formats a prefix as a dotted mask', () => {
    expect(formatSubnetMask(PrefixLength.parse(24))).toBe('255.255.255.0');
    expect(formatSubnetMask(PrefixLength.parse(0))).toBe('0.0.0.0');
    expect(formatSubnetMask(PrefixLength.parse(32))).toBe('255.255.255.255');
  });

  it('parses every formatted prefix back to the same prefix', () => {
    for (let prefix = 0; prefix <= 32; prefix++) {
      expect(SubnetMask.parse(formatSubnetMask(PrefixLength.parse(prefix)))).toBe(prefix);
    }
  });
});

describe('PrefixLength', () => {
  it.each([-1, 33, 24.5])('rejects %d', (value) => {
    expect(PrefixLength.safeParse(value).success).toBe(false);
  });
});

describe('MacAddress', () => {
  it.each(['02:00:5E:10:00:01', '02-00-5e-10-00-01', '0200.5e10.0001'])(
    'reads %s in canonical form',
    (text) => {
      expect(MacAddress.parse(text)).toBe('02:00:5e:10:00:01');
    },
  );

  it.each(['02:00-5e:10:00:01', '02:00:5e:10:00', '02:00:5e:10:00:0g', '02005e100001', ''])(
    'rejects %j',
    (text) => {
      expect(MacAddress.safeParse(text).success).toBe(false);
    },
  );
});

describe('VlanId', () => {
  it.each([1, 10, 4094])('accepts %i', (value) => {
    expect(VlanId.parse(value)).toBe(value);
  });

  it.each([0, 4095, 1.5])('rejects %d', (value) => {
    expect(VlanId.safeParse(value).success).toBe(false);
  });
});

describe('Hostname', () => {
  it.each(['R1', 'Core-SW_2', 'a', `R${'1'.repeat(62)}`])('accepts %s', (text) => {
    expect(Hostname.parse(text)).toBe(text);
  });

  it.each(['1R', 'R-', 'Web Server', '', `R${'1'.repeat(63)}`])('rejects %j', (text) => {
    expect(Hostname.safeParse(text).success).toBe(false);
  });
});
