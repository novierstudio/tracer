// Twofish block cipher (Schneier et al., 1998), encryption direction only.
// EAX uses the forward cipher for both CTR and OMAC, so decryption is not needed.

export type BlockCipher = {
  /** Encrypts the first 16 bytes of `block` in place. */
  readonly encryptBlock: (block: Uint8Array) => void;
};

// Nibble tables that build the fixed permutations q0 and q1 (paper, section 4.3.5).
const Q_NIBBLES = [
  [
    [0x8, 0x1, 0x7, 0xd, 0x6, 0xf, 0x3, 0x2, 0x0, 0xb, 0x5, 0x9, 0xe, 0xc, 0xa, 0x4],
    [0xe, 0xc, 0xb, 0x8, 0x1, 0x2, 0x3, 0x5, 0xf, 0x4, 0xa, 0x6, 0x7, 0x0, 0x9, 0xd],
    [0xb, 0xa, 0x5, 0xe, 0x6, 0xd, 0x9, 0x0, 0xc, 0x8, 0xf, 0x3, 0x2, 0x4, 0x7, 0x1],
    [0xd, 0x7, 0xf, 0x4, 0x1, 0x2, 0x6, 0xe, 0x9, 0xb, 0x3, 0x0, 0x8, 0x5, 0xc, 0xa],
  ],
  [
    [0x2, 0x8, 0xb, 0xd, 0xf, 0x7, 0x6, 0xe, 0x3, 0x1, 0x9, 0x4, 0x0, 0xa, 0xc, 0x5],
    [0x1, 0xe, 0x2, 0xb, 0x4, 0xc, 0x3, 0x7, 0x6, 0xd, 0xa, 0x5, 0xf, 0x9, 0x0, 0x8],
    [0x4, 0xc, 0x7, 0x5, 0x1, 0x6, 0x9, 0xa, 0x0, 0xe, 0xd, 0x8, 0x2, 0xb, 0x3, 0xf],
    [0xb, 0x9, 0x5, 0x1, 0xc, 0x3, 0xd, 0xe, 0x6, 0x4, 0x7, 0xf, 0x2, 0x0, 0x8, 0xa],
  ],
] as const;

function buildQ(t: (typeof Q_NIBBLES)[number]): Uint8Array {
  const q = new Uint8Array(256);
  const ror4 = (x: number) => ((x >> 1) | (x << 3)) & 0xf;
  for (let x = 0; x < 256; x++) {
    const a0 = x >> 4;
    const b0 = x & 0xf;
    const a2 = t[0][a0 ^ b0]!;
    const b2 = t[1][a0 ^ ror4(b0) ^ ((8 * a0) & 0xf)]!;
    const a4 = t[2][a2 ^ b2]!;
    const b4 = t[3][a2 ^ ror4(b2) ^ ((8 * a2) & 0xf)]!;
    q[x] = (b4 << 4) | a4;
  }
  return q;
}

const Q0 = buildQ(Q_NIBBLES[0]);
const Q1 = buildQ(Q_NIBBLES[1]);

/** Multiplication in GF(2^8) modulo `poly` (which includes the x^8 term). */
function gfMul(a: number, b: number, poly: number): number {
  let product = 0;
  for (; b > 0; b >>= 1) {
    if (b & 1) product ^= a;
    a <<= 1;
    if (a & 0x100) a ^= poly;
  }
  return product;
}

const MDS_POLY = 0x169;
const MDS = [
  [0x01, 0xef, 0x5b, 0x5b],
  [0x5b, 0xef, 0xef, 0x01],
  [0xef, 0x5b, 0x01, 0xef],
  [0xef, 0x01, 0xef, 0x5b],
] as const;

const RS_POLY = 0x14d;
const RS = [
  [0x01, 0xa4, 0x55, 0x87, 0x5a, 0x58, 0xdb, 0x9e],
  [0xa4, 0x56, 0x82, 0xf3, 0x1e, 0xc6, 0x68, 0xe5],
  [0x02, 0xa1, 0xfc, 0xc1, 0x47, 0xae, 0x3d, 0x19],
  [0xa4, 0x55, 0x87, 0x5a, 0x58, 0xdb, 0x9e, 0x03],
] as const;

/** Column `col` of the MDS matrix times byte `y`, packed little-endian. */
function mdsColumn(col: number, y: number): number {
  let word = 0;
  for (let row = 0; row < 4; row++) word |= gfMul(MDS[row]![col]!, y, MDS_POLY) << (8 * row);
  return word;
}

// The q permutation h applies to each byte at each stage. Row 0 is the last one applied.
// Row s >= 1 is followed by an XOR with key word s - 1, and only rows 1..k run.
const H_STAGES = [
  [Q1, Q0, Q1, Q0],
  [Q0, Q0, Q1, Q1],
  [Q0, Q1, Q0, Q1],
  [Q1, Q1, Q0, Q0],
  [Q1, Q0, Q0, Q1],
] as const;

/** The byte-wise half of h: q-boxes keyed by `words`, before the MDS multiply. */
function keyedSbox(byteIndex: number, x: number, words: readonly number[]): number {
  const k = words.length;
  // Stage 4 runs only for 256-bit keys, stage 3 for 192- and 256-bit keys.
  for (let stage = k; stage >= 1; stage--) {
    x = H_STAGES[stage]![byteIndex]![x]! ^ ((words[stage - 1]! >>> (8 * byteIndex)) & 0xff);
  }
  return H_STAGES[0][byteIndex]![x]!;
}

function h(x: number, words: readonly number[]): number {
  let z = 0;
  for (let i = 0; i < 4; i++) z ^= mdsColumn(i, keyedSbox(i, (x >>> (8 * i)) & 0xff, words));
  return z;
}

const rol = (x: number, n: number) => (x << n) | (x >>> (32 - n));
const ror = (x: number, n: number) => (x >>> n) | (x << (32 - n));

function readWord(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! |
    (bytes[offset + 1]! << 8) |
    (bytes[offset + 2]! << 16) |
    (bytes[offset + 3]! << 24)
  );
}

function writeWord(bytes: Uint8Array, offset: number, word: number): void {
  bytes[offset] = word;
  bytes[offset + 1] = word >>> 8;
  bytes[offset + 2] = word >>> 16;
  bytes[offset + 3] = word >>> 24;
}

/** Keys a Twofish instance. `key` must be 16, 24 or 32 bytes. */
export function twofish(key: Uint8Array): BlockCipher {
  if (key.length !== 16 && key.length !== 24 && key.length !== 32) {
    throw new RangeError(`Twofish key must be 16, 24 or 32 bytes, got ${key.length}`);
  }
  const k = key.length / 8;
  const even: number[] = [];
  const odd: number[] = [];
  const sbox: number[] = [];
  for (let i = 0; i < k; i++) {
    even.push(readWord(key, 8 * i));
    odd.push(readWord(key, 8 * i + 4));
    let s = 0;
    for (let row = 0; row < 4; row++) {
      let byte = 0;
      for (let col = 0; col < 8; col++) byte ^= gfMul(RS[row]![col]!, key[8 * i + col]!, RS_POLY);
      s |= byte << (8 * row);
    }
    // The S-box key words are used in reverse order.
    sbox.unshift(s);
  }

  const subkeys = new Int32Array(40);
  for (let i = 0; i < 20; i++) {
    const a = h(Math.imul(2 * i, 0x01010101), even);
    const b = rol(h(Math.imul(2 * i + 1, 0x01010101), odd), 8);
    subkeys[2 * i] = a + b;
    subkeys[2 * i + 1] = rol((a + 2 * b) | 0, 9);
  }

  // Full keying: fold the key-dependent S-boxes and the MDS multiply into four lookup tables.
  const t0 = new Int32Array(256);
  const t1 = new Int32Array(256);
  const t2 = new Int32Array(256);
  const t3 = new Int32Array(256);
  for (let x = 0; x < 256; x++) {
    t0[x] = mdsColumn(0, keyedSbox(0, x, sbox));
    t1[x] = mdsColumn(1, keyedSbox(1, x, sbox));
    t2[x] = mdsColumn(2, keyedSbox(2, x, sbox));
    t3[x] = mdsColumn(3, keyedSbox(3, x, sbox));
  }
  const g0 = (x: number) =>
    t0[x & 0xff]! ^ t1[(x >>> 8) & 0xff]! ^ t2[(x >>> 16) & 0xff]! ^ t3[x >>> 24]!;
  // g(rol(x, 8)) without the rotate.
  const g1 = (x: number) =>
    t0[x >>> 24]! ^ t1[x & 0xff]! ^ t2[(x >>> 8) & 0xff]! ^ t3[(x >>> 16) & 0xff]!;

  return {
    encryptBlock(block) {
      let a = readWord(block, 0) ^ subkeys[0]!;
      let b = readWord(block, 4) ^ subkeys[1]!;
      let c = readWord(block, 8) ^ subkeys[2]!;
      let d = readWord(block, 12) ^ subkeys[3]!;
      // Two rounds per iteration, so the halves swap roles instead of being moved.
      for (let r = 8; r < 40; r += 4) {
        let x = g0(a);
        let y = g1(b);
        c = ror(c ^ (x + y + subkeys[r]!), 1);
        d = rol(d, 1) ^ (x + 2 * y + subkeys[r + 1]!);
        x = g0(c);
        y = g1(d);
        a = ror(a ^ (x + y + subkeys[r + 2]!), 1);
        b = rol(b, 1) ^ (x + 2 * y + subkeys[r + 3]!);
      }
      writeWord(block, 0, c ^ subkeys[4]!);
      writeWord(block, 4, d ^ subkeys[5]!);
      writeWord(block, 8, a ^ subkeys[6]!);
      writeWord(block, 12, b ^ subkeys[7]!);
    },
  };
}
