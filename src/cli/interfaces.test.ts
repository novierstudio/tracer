import { describe, expect, it } from 'vitest';
import { expandInterfaceRange, normalizeInterface } from './interfaces';

describe('normalizeInterface', () => {
  it.each([
    ['g0/0', 'GigabitEthernet0/0'],
    ['gi0/0', 'GigabitEthernet0/0'],
    ['Gig0/1', 'GigabitEthernet0/1'],
    ['GigabitEthernet0/0', 'GigabitEthernet0/0'],
    ['gigabitethernet 0/0', 'GigabitEthernet0/0'],
    ['fa0/1', 'FastEthernet0/1'],
    ['f0/01', 'FastEthernet0/1'],
    ['s0/0/0', 'Serial0/0/0'],
    ['lo0', 'Loopback0'],
    ['vlan1', 'Vlan1'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeInterface(input)).toBe(expected);
  });

  it.each(['x0/0', 'g', 'g0/', '0/0', 'g0/0 - 2', '', 'e0', 'vlan0', 'lo01x'])(
    'rejects %j',
    (input) => {
      expect(normalizeInterface(input)).toBeUndefined();
    },
  );
});

describe('expandInterfaceRange', () => {
  it.each([['f0/1 - 3'], ['f0/1-3'], ['f0/1 -3'], ['fa0/1- 3']])('expands %j', (input) => {
    expect(expandInterfaceRange(input)).toEqual([
      'FastEthernet0/1',
      'FastEthernet0/2',
      'FastEthernet0/3',
    ]);
  });

  it('accepts a single interface', () => {
    expect(expandInterfaceRange('g0/1')).toEqual(['GigabitEthernet0/1']);
  });

  it.each(['f0/5 - 1', 'f0/1 - 99999', 'f0/1 -', 'x0/1 - 2'])('rejects %j', (input) => {
    expect(expandInterfaceRange(input)).toBeUndefined();
  });
});
