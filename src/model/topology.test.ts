// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { InterfaceId, PortId, SubinterfaceId, VirtualInterfaceId } from './topology';

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
