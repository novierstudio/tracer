/** What every dissector shares: byte encoders, the internet checksum, and how a duration reads. */

/** A field before it is placed on the wire: its bytes, in wire order with the others. */
export type Part = {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly explain: string;
  readonly bytes: readonly number[];
};

export const u16 = (value: number) => [(value >> 8) & 0xff, value & 0xff];
export const u32 = (value: number) => [...u16(Math.floor(value / 0x10000)), ...u16(value & 0xffff)];
export const ipBytes = (address: string) => address.split('.').map(Number);
export const macBytes = (mac: string) => mac.split(':').map((part) => parseInt(part, 16));
export const hex = (value: number, digits: number) =>
  `0x${value.toString(16).toUpperCase().padStart(digits, '0')}`;

/** The internet checksum: the ones' complement of the ones' complement sum of 16-bit words. */
export function internetChecksum(bytes: readonly number[]): number {
  let sum = 0;
  for (let index = 0; index < bytes.length; index += 2) {
    sum += (bytes[index]! << 8) | (bytes[index + 1] ?? 0);
  }
  while (sum > 0xffff) sum = (sum & 0xffff) + (sum >>> 16);
  return ~sum & 0xffff;
}

const UNITS = [
  [86400, 'day'],
  [3600, 'hour'],
  [60, 'minute'],
  [1, 'second'],
] as const;

/** `86400` as `86400 s (1 day)`, `5400` as `5400 s (1 hour 30 minutes)`. */
export function formatSeconds(seconds: number): string {
  const words: string[] = [];
  let rest = seconds;
  for (const [size, unit] of UNITS) {
    const count = Math.floor(rest / size);
    rest -= count * size;
    if (count > 0) words.push(`${count} ${unit}${count === 1 ? '' : 's'}`);
  }
  return words.length > 0 ? `${seconds} s (${words.join(' ')})` : '0 s';
}
