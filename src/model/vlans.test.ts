// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { Switchport, VlanRange } from './topology';
import { VlanId } from './values';
import { addVlans, carriesVlan, formatVlans, removeVlans, vlanAllowed } from './vlans';

const ranges = (...pairs: [number, number][]): VlanRange[] =>
  pairs.map(([first, last]) => ({ first: VlanId.parse(first), last: VlanId.parse(last) }));
const vlan = (n: number) => VlanId.parse(n);

describe('VLAN lists', () => {
  it('merges ranges that overlap or touch when adding', () => {
    expect(addVlans(ranges([10, 10], [30, 40]), ranges([11, 12], [35, 50]))).toEqual(
      ranges([10, 12], [30, 50]),
    );
  });

  it('splits a range when removing from its middle', () => {
    expect(removeVlans(ranges([1, 4094]), ranges([20, 20]))).toEqual(ranges([1, 19], [21, 4094]));
    expect(removeVlans(ranges([10, 10], [20, 20]), ranges([1, 15]))).toEqual(ranges([20, 20]));
  });

  it('prints lists as IOS does', () => {
    expect(formatVlans(undefined)).toBe('1-4094');
    expect(formatVlans([])).toBe('none');
    expect(formatVlans(ranges([1, 1], [10, 11], [20, 30]))).toBe('1,10,11,20-30');
  });

  it('treats no list as every VLAN', () => {
    expect(vlanAllowed(undefined, vlan(4094))).toBe(true);
    expect(vlanAllowed([], vlan(1))).toBe(false);
    expect(vlanAllowed(ranges([10, 20]), vlan(15))).toBe(true);
  });

  it('carries the access VLAN on an access port and the allowed VLANs on a trunk', () => {
    const access: Switchport = { mode: 'access', vlan: vlan(10), allowedVlans: [] };
    const trunk: Switchport = {
      mode: 'trunk',
      nativeVlan: vlan(1),
      allowedVlans: ranges([10, 10]),
    };
    expect(carriesVlan(access, vlan(10))).toBe(true);
    expect(carriesVlan(access, vlan(20))).toBe(false);
    expect(carriesVlan(trunk, vlan(10))).toBe(true);
    expect(carriesVlan(trunk, vlan(1))).toBe(false);
  });
});
