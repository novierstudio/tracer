import { describe, expect, it } from 'vitest';
import { cidr, labBuilder } from '@/engine/testing';
import { portRows } from './view';

describe('portRows', () => {
  it("shows a multilayer switch's routed port with its address, and its switchports by VLAN", () => {
    const lab = labBuilder();
    const mls = lab.switch('MLS', {}, 'switch-l3-24');
    lab.edit(mls, (device) => {
      if (device.kind !== 'switch') return device;
      const interfaces = { ...device.config.interfaces };
      interfaces['GigabitEthernet0/1' as never] = { shutdown: false, ipv4: cidr('10.0.0.1/30') };
      return { ...device, config: { ...device.config, interfaces } };
    });

    const rows = portRows(lab.topology, lab.device(mls));
    expect(rows.find((row) => row.id === 'GigabitEthernet0/1')).toMatchObject({
      layer: 'routed',
      ipv4: { address: '10.0.0.1', prefixLength: 30 },
    });
    expect(rows.find((row) => row.id === 'FastEthernet0/1')).toMatchObject({
      layer: 'switched',
      vlan: 'VLAN 1',
    });
  });
});
