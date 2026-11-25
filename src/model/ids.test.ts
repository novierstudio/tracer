// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { DeviceId, LinkId, createIdSource } from './ids';

const sample = (seed: number) => {
  const ids = createIdSource(seed);
  return [ids.deviceId(), ids.linkId(), ids.annotationId(), ids.macAddress(), ids.deviceId()];
};

describe('createIdSource', () => {
  it('produces the same sequence for the same seed', () => {
    expect(sample(42)).toEqual(sample(42));
  });

  it('produces a different sequence for a different seed', () => {
    expect(sample(42)).not.toEqual(sample(43));
  });

  it('makes short ids that only parse as their own kind', () => {
    const ids = createIdSource(7);
    const deviceId = ids.deviceId();

    expect(deviceId).toMatch(/^dev_[0-9A-Za-z]{10}$/);
    expect(DeviceId.safeParse(deviceId).success).toBe(true);
    expect(LinkId.safeParse(deviceId).success).toBe(false);
  });

  it('makes unique, locally administered unicast MAC addresses', () => {
    const ids = createIdSource(1);
    const macs = Array.from({ length: 1000 }, () => ids.macAddress());

    expect(new Set(macs).size).toBe(macs.length);
    for (const mac of macs) {
      expect(mac).toMatch(/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/);
      expect(Number.parseInt(mac.slice(0, 2), 16) & 0b11).toBe(0b10);
    }
  });
});
