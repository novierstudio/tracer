// Packet Tracer .pkt / .pka files: decryptPkt and its inverse, encryptPkt.
// The scheme was reverse-engineered by pka2xml (include/pka2xml.hpp). With l = byte length:
//   1. reverse the bytes, XORing byte i with (l - i * l)
//   2. Twofish-EAX, key 0x89 x 16, nonce 0x10 x 16, 16-byte tag at the end
//   3. XOR byte i with (l - i)
//   4. Qt qCompress: 4-byte big-endian uncompressed size, then a zlib stream
// Files from Packet Tracer 5.x and earlier ("legacy") use only stages 3 and 4.

import { unzlibSync, zlibSync } from 'fflate';
import { eaxOpen, eaxSeal } from './eax';
import { twofish } from './twofish';

export type PktFormat = 'modern' | 'legacy';

export type DecryptError =
  /** Shorter than the smallest possible file of either format. */
  | { readonly kind: 'too-short'; readonly length: number }
  /** The EAX tag did not verify and the bytes do not look like a legacy file either. */
  | { readonly kind: 'bad-tag' }
  /** The container opened but the payload is not a valid zlib stream. */
  | { readonly kind: 'bad-zlib'; readonly format: PktFormat; readonly message: string };

export type DecryptResult =
  | { readonly ok: true; readonly xml: string; readonly format: PktFormat }
  | { readonly ok: false; readonly error: DecryptError };

const CIPHER = twofish(new Uint8Array(16).fill(0x89));
const NONCE = new Uint8Array(16).fill(0x10);
const NO_HEADER = new Uint8Array(0);

// A 4-byte size prefix plus the 8-byte zlib stream of an empty input.
const MIN_LENGTH = 12;

/** Stage 1: read the file backwards, XORing with a key derived from its length. */
function unscramble(bytes: Uint8Array): Uint8Array {
  const l = bytes.length;
  const out = new Uint8Array(l);
  // Math.imul keeps the 32-bit wraparound of the C++ original. Only the low byte matters.
  for (let i = 0; i < l; i++) out[i] = bytes[l - 1 - i]! ^ ((l - Math.imul(i, l)) & 0xff);
  return out;
}

/** Inverse of `unscramble`. */
function scramble(bytes: Uint8Array): Uint8Array {
  const l = bytes.length;
  const out = new Uint8Array(l);
  for (let i = 0; i < l; i++) out[l - 1 - i] = bytes[i]! ^ ((l - Math.imul(i, l)) & 0xff);
  return out;
}

/** Stage 3: XOR each byte with its distance from the end. It is its own inverse. */
function xorWithRemaining(bytes: Uint8Array): Uint8Array {
  const l = bytes.length;
  const out = new Uint8Array(l);
  for (let i = 0; i < l; i++) out[i] = bytes[i]! ^ ((l - i) & 0xff);
  return out;
}

/** A zlib header (deflate method, valid check bits) right after the 4-byte size prefix. */
function hasZlibHeader(payload: Uint8Array): boolean {
  const cmf = payload[4]!;
  const flg = payload[5]!;
  return (cmf & 0x0f) === 8 && ((cmf << 8) | flg) % 31 === 0;
}

/** Stage 4. The size prefix is only a hint, as in Qt's qUncompress, so it is skipped. */
function inflate(payload: Uint8Array, format: PktFormat): DecryptResult {
  try {
    const xml = new TextDecoder().decode(unzlibSync(payload.subarray(4)));
    return { ok: true, xml, format };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: { kind: 'bad-zlib', format, message } };
  }
}

export function decryptPkt(bytes: Uint8Array): DecryptResult {
  if (bytes.length < MIN_LENGTH) {
    return { ok: false, error: { kind: 'too-short', length: bytes.length } };
  }
  const opened = eaxOpen(CIPHER, NONCE, NO_HEADER, unscramble(bytes));
  if (opened) return inflate(xorWithRemaining(opened), 'modern');
  // The tag is the authoritative check, so legacy is only tried once it fails.
  const legacy = xorWithRemaining(bytes);
  if (hasZlibHeader(legacy)) return inflate(legacy, 'legacy');
  return { ok: false, error: { kind: 'bad-tag' } };
}

/** Writes `xml` as a modern (Packet Tracer 6.x and later) file. */
export function encryptPkt(xml: string): Uint8Array {
  const data = new TextEncoder().encode(xml);
  const compressed = zlibSync(data);
  const payload = new Uint8Array(4 + compressed.length);
  new DataView(payload.buffer).setUint32(0, data.length);
  payload.set(compressed, 4);
  return scramble(eaxSeal(CIPHER, NONCE, NO_HEADER, xorWithRemaining(payload)));
}
