// @vitest-environment node
import { describe, expect, it } from 'vitest';
import ecbTable from './__fixtures__/twofish-ecb_tbl.txt?raw';
import { twofish } from './twofish';

const fromHex = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], (b) => parseInt(b, 16));
const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();

type Vector = { keySize: number; i: number; key: string; pt: string; ct: string };

/** Parses the KEYSIZE / I / KEY / PT / CT blocks of the official Twofish ecb_tbl.txt. */
function parseEcbTable(text: string): Vector[] {
  const vectors: Vector[] = [];
  let current: Partial<Vector> = {};
  for (const line of text.split(/\r?\n/)) {
    const [name, value] = line.split('=');
    if (value === undefined) continue;
    if (name === 'KEYSIZE') current.keySize = Number(value);
    if (name === 'I') current.i = Number(value);
    if (name === 'KEY') current.key = value;
    if (name === 'PT') current.pt = value;
    if (name === 'CT') {
      vectors.push({ ...current, ct: value } as Vector);
      current = { keySize: current.keySize };
    }
  }
  return vectors;
}

const vectors = parseEcbTable(ecbTable);

describe('twofish', () => {
  it('reads all 49 vectors for each key size from ecb_tbl.txt', () => {
    expect(vectors.map((v) => v.keySize)).toEqual([
      ...Array<number>(49).fill(128),
      ...Array<number>(49).fill(192),
      ...Array<number>(49).fill(256),
    ]);
  });

  it.each(vectors)('ecb_tbl KEYSIZE=$keySize I=$i', ({ key, pt, ct }) => {
    const block = fromHex(pt);
    twofish(fromHex(key)).encryptBlock(block);
    expect(toHex(block)).toBe(ct);
  });

  it('rejects keys that are not 128, 192 or 256 bits', () => {
    expect(() => twofish(new Uint8Array(15))).toThrow(RangeError);
  });
});
