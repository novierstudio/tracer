import { describe, expect, it } from 'vitest';
import { DEVICE_MODELS } from './catalog';
import { normalizePortName } from './interfaces';

describe('normalizePortName', () => {
  it.each([
    ['GigabitEthernet0/0', 'GigabitEthernet0/0'],
    ['gigabitethernet0/0', 'GigabitEthernet0/0'],
    ['Gi0/0', 'GigabitEthernet0/0'],
    ['gi0/0', 'GigabitEthernet0/0'],
    ['g0/0', 'GigabitEthernet0/0'],
    ['Gi 0/1', 'GigabitEthernet0/1'],
    ['  g0/01 ', 'GigabitEthernet0/1'],
    ['Fa0/24', 'FastEthernet0/24'],
    ['f0/1', 'FastEthernet0/1'],
    ['fa0', 'FastEthernet0'],
    ['Se0/0/1', 'Serial0/0/1'],
    ['s0/0/0', 'Serial0/0/0'],
    ['serial0/0/0', 'Serial0/0/0'],
  ])('reads %j as %s', (text, expected) => {
    expect(normalizePortName(text)).toBe(expected);
  });

  it.each(['', 'gi', '0/0', 'x0/0', 'Loopback0', 'Vlan1', 'Gi0/', 'Gi/0', 'GigabitEthernet0/0x'])(
    'rejects %j',
    (text) => {
      expect(normalizePortName(text)).toBeUndefined();
    },
  );

  it('keeps every catalog port name as it is', () => {
    const names = DEVICE_MODELS.flatMap((model) => model.ports.map((port) => port.id));
    expect(names.map(normalizePortName)).toEqual(names);
  });
});
