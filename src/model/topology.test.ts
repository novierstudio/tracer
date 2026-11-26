// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  DhcpExcludedRange,
  DhcpLease,
  DhcpServerConfig,
  InterfaceId,
  MAX_LEASE_MINUTES,
  PortId,
  SubinterfaceId,
  VirtualInterfaceId,
} from './topology';

describe('InterfaceId', () => {
  it.each(['GigabitEthernet0/0', 'FastEthernet0/1', 'Serial0/0/0'])(
    'reads %s as a port',
    (name) => {
      expect(PortId.safeParse(name).success).toBe(true);
      expect(InterfaceId.parse(name)).toBe(name);
    },
  );

  it.each(['Loopback0', 'Loopback2147483647', 'Vlan1', 'Vlan4094'])(
    'reads %s as a virtual interface',
    (name) => {
      expect(PortId.safeParse(name).success).toBe(false);
      expect(VirtualInterfaceId.parse(name)).toBe(name);
      expect(InterfaceId.parse(name)).toBe(name);
    },
  );

  it.each(['GigabitEthernet0/0.10', 'FastEthernet0/1.1', 'GigabitEthernet0/0.4294967295'])(
    'reads %s as a subinterface',
    (name) => {
      expect(PortId.safeParse(name).success).toBe(false);
      expect(SubinterfaceId.parse(name)).toBe(name);
      expect(InterfaceId.parse(name)).toBe(name);
    },
  );

  it.each(['Serial0/0/0.1', 'GigabitEthernet0/0.0', 'GigabitEthernet0/0.4294967296'])(
    'rejects the subinterface %j',
    (name) => {
      expect(InterfaceId.safeParse(name).success).toBe(false);
    },
  );

  it.each(['Vlan0', 'Vlan4095', 'Loopback2147483648', 'Loopback01', 'Ethernet0', 'vlan1', ''])(
    'rejects %j',
    (name) => {
      expect(InterfaceId.safeParse(name).success).toBe(false);
    },
  );
});

describe('DhcpServerConfig', () => {
  it('reads pools by name and excluded ranges', () => {
    const config = DhcpServerConfig.parse({
      pools: {
        LAN: {
          network: { address: '192.168.1.0', prefixLength: 24 },
          defaultRouters: ['192.168.1.1'],
          dnsServers: ['8.8.8.8', '8.8.4.4'],
          lease: 'infinite',
        },
        EMPTY: {},
      },
      excluded: [{ first: '192.168.1.1', last: '192.168.1.10' }],
    });
    expect(Object.keys(config.pools)).toEqual(['LAN', 'EMPTY']);
    expect(config.pools.LAN!.lease).toBe('infinite');
  });

  it('refuses an excluded range that runs backwards', () => {
    const range = { first: '192.168.1.10', last: '192.168.1.1' };
    expect(DhcpExcludedRange.safeParse(range).success).toBe(false);
  });

  it.each([0, MAX_LEASE_MINUTES + 1, 1.5])('refuses a lease of %d minutes', (minutes) => {
    expect(DhcpLease.safeParse(minutes).success).toBe(false);
  });
});
