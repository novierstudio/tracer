// EAX authenticated encryption (Bellare, Rogaway, Wagner) over any 128-bit block cipher,
// with a full 16-byte tag appended to the ciphertext, as Crypto++'s EAX<Twofish> writes it.

import type { BlockCipher } from './twofish';

export const EAX_TAG_LENGTH = 16;

/** Doubling in GF(2^128), as CMAC derives its subkeys. */
function double(block: Uint8Array): Uint8Array {
  const out = new Uint8Array(16);
  for (let i = 0; i < 15; i++) out[i] = (block[i]! << 1) | (block[i + 1]! >>> 7);
  out[15] = (block[15]! << 1) ^ (block[0]! & 0x80 ? 0x87 : 0);
  return out;
}

function xorInto(target: Uint8Array, source: Uint8Array, length = source.length): void {
  for (let i = 0; i < length; i++) target[i]! ^= source[i]!;
}

/** OMAC^t(data): CMAC over the 16-byte block [0, ..., 0, t] followed by `data`. */
function omac(cipher: BlockCipher, t: number, data: Uint8Array): Uint8Array {
  const l = new Uint8Array(16);
  cipher.encryptBlock(l);
  const k1 = double(l);

  const state = new Uint8Array(16);
  state[15] = t;
  if (data.length === 0) {
    xorInto(state, k1);
    cipher.encryptBlock(state);
    return state;
  }
  cipher.encryptBlock(state);

  // Every block but the last one goes straight through the cipher.
  const lastStart = Math.ceil(data.length / 16) * 16 - 16;
  for (let offset = 0; offset < lastStart; offset += 16) {
    xorInto(state, data.subarray(offset, offset + 16));
    cipher.encryptBlock(state);
  }
  const last = data.subarray(lastStart);
  xorInto(state, last);
  if (last.length === 16) {
    xorInto(state, k1);
  } else {
    state[last.length]! ^= 0x80;
    xorInto(state, double(k1));
  }
  cipher.encryptBlock(state);
  return state;
}

/** CTR mode with a 128-bit big-endian counter starting at `initial`. */
function ctr(cipher: BlockCipher, initial: Uint8Array, input: Uint8Array): Uint8Array {
  const output = new Uint8Array(input.length);
  const counter = initial.slice();
  const keystream = new Uint8Array(16);
  for (let offset = 0; offset < input.length; offset += 16) {
    keystream.set(counter);
    cipher.encryptBlock(keystream);
    const end = Math.min(offset + 16, input.length);
    for (let i = offset; i < end; i++) output[i] = input[i]! ^ keystream[i - offset]!;
    // Increment as one big-endian number. Uint8Array stores 256 as 0, so 0 means carry.
    for (let i = 15; i >= 0; i--) {
      counter[i] = counter[i]! + 1;
      if (counter[i] !== 0) break;
    }
  }
  return output;
}

function tag(
  cipher: BlockCipher,
  nonceMac: Uint8Array,
  header: Uint8Array,
  ciphertext: Uint8Array,
): Uint8Array {
  const t = omac(cipher, 2, ciphertext);
  xorInto(t, nonceMac);
  xorInto(t, omac(cipher, 1, header));
  return t;
}

/** Encrypts `plaintext` and returns the ciphertext followed by the 16-byte tag. */
export function eaxSeal(
  cipher: BlockCipher,
  nonce: Uint8Array,
  header: Uint8Array,
  plaintext: Uint8Array,
): Uint8Array {
  const nonceMac = omac(cipher, 0, nonce);
  const sealed = new Uint8Array(plaintext.length + EAX_TAG_LENGTH);
  const ciphertext = ctr(cipher, nonceMac, plaintext);
  sealed.set(ciphertext);
  sealed.set(tag(cipher, nonceMac, header, ciphertext), plaintext.length);
  return sealed;
}

/** Verifies the tag on `sealed` and returns the plaintext, or null when it does not match. */
export function eaxOpen(
  cipher: BlockCipher,
  nonce: Uint8Array,
  header: Uint8Array,
  sealed: Uint8Array,
): Uint8Array | null {
  if (sealed.length < EAX_TAG_LENGTH) return null;
  const ciphertext = sealed.subarray(0, sealed.length - EAX_TAG_LENGTH);
  const nonceMac = omac(cipher, 0, nonce);
  const expected = tag(cipher, nonceMac, header, ciphertext);
  let diff = 0;
  for (let i = 0; i < EAX_TAG_LENGTH; i++) diff |= expected[i]! ^ sealed[ciphertext.length + i]!;
  return diff === 0 ? ctr(cipher, nonceMac, ciphertext) : null;
}
