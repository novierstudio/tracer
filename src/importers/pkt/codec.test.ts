// @vitest-environment node
import { readFileSync } from 'node:fs';
import { unzlibSync, zlibSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { decryptPkt, encryptPkt } from './codec';
import { eaxOpen, eaxSeal } from './eax';
import { twofish } from './twofish';

const utf8 = (text: string) => new TextEncoder().encode(text);

// Line-by-line transcriptions of pka2xml.hpp, so decryptPkt is checked against the reference
// formulas and not only against its own inverse.
const pka2xml = {
  /** compress(): 4-byte big-endian size, then zlib. */
  compress(data: Uint8Array): Uint8Array {
    const z = zlibSync(data);
    const out = new Uint8Array(4 + z.length);
    out.set([data.length >>> 24, data.length >>> 16, data.length >>> 8, data.length], 0);
    out.set(z, 4);
    return out;
  },
  /** encrypt() stage 2 and decrypt_old(): output[i] = output[i] ^ (output.size() - i). */
  xor(input: Uint8Array): Uint8Array {
    return input.map((byte, i) => byte ^ (input.length - i));
  },
  /** encrypt() stages 3 and 4: Twofish-EAX, then output[length + ~i] = encrypted[i] ^ (length - i * length). */
  encrypt(input: Uint8Array): Uint8Array {
    const key = new Uint8Array(16).fill(137);
    const iv = new Uint8Array(16).fill(16);
    const encrypted = eaxSeal(twofish(key), iv, new Uint8Array(0), input);
    const length = encrypted.length;
    const output = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      output[length + ~i] = encrypted[i]! ^ (length - Math.imul(i, length));
    }
    return output;
  },
  /** decrypt(): processed[i] = input[length + ~i] ^ (length - i * length), Twofish-EAX, XOR, uncompress. */
  decrypt(input: Uint8Array): string {
    const length = input.length;
    const processed = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      processed[i] = input[length + ~i]! ^ (length - Math.imul(i, length));
    }
    const key = new Uint8Array(16).fill(137);
    const iv = new Uint8Array(16).fill(16);
    const output = eaxOpen(twofish(key), iv, new Uint8Array(0), processed);
    if (!output) throw new Error('EAX tag mismatch');
    const data = pka2xml.xor(output);
    const size = new DataView(data.buffer).getUint32(0);
    const xml = unzlibSync(data.subarray(4));
    expect(xml.length).toBe(size);
    return new TextDecoder().decode(xml);
  },
};

const xml =
  '<PACKETTRACER5><VERSION>8.2.2.0400</VERSION><NAME>Routeur été 東京</NAME></PACKETTRACER5>';

const fixture = (name: string) => readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url));

describe('decryptPkt on real Packet Tracer files', () => {
  it.each([
    ['pt7.1-eigrp-lab.pkt', '7.1.0.0222'],
    ['pt8.2-vtp-lab.pkt', '8.2.2.0400'],
  ])('decrypts %s, saved by Packet Tracer %s', (name, version) => {
    const result = decryptPkt(fixture(name));
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(result.format).toBe('modern');
    expect(result.xml).toMatch(/^<PACKETTRACER5>\s*<VERSION>([^<]+)<\/VERSION>/);
    expect(result.xml).toContain(`<VERSION>${version}</VERSION>`);
    expect(result.xml.trimEnd()).toMatch(/<\/PACKETTRACER5>$/);
  });

  it('re-encrypts real XML so that it decrypts to the same text', () => {
    const result = decryptPkt(fixture('pt8.2-vtp-lab.pkt'));
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(decryptPkt(encryptPkt(result.xml))).toEqual(result);
  });
});

describe('decryptPkt and encryptPkt', () => {
  it('decrypts a file built with the pka2xml encrypt steps', () => {
    const file = pka2xml.encrypt(pka2xml.xor(pka2xml.compress(utf8(xml))));
    expect(decryptPkt(file)).toEqual({ ok: true, xml, format: 'modern' });
  });

  it('writes files that the pka2xml decrypt steps read back', () => {
    expect(pka2xml.decrypt(encryptPkt(xml))).toBe(xml);
  });

  it.each([
    ['a minimal document', '<PACKETTRACER5/>'],
    ['non-ASCII text', xml],
    [
      'a 200 KB document',
      `<PACKETTRACER5>${'<LINE>interface GigabitEthernet0/0</LINE>'.repeat(5000)}</PACKETTRACER5>`,
    ],
  ])('round-trips %s', (_, text) => {
    expect(decryptPkt(encryptPkt(text))).toEqual({ ok: true, xml: text, format: 'modern' });
  });

  it('decrypts a legacy (Packet Tracer 5.x) file, which has no encryption layer', () => {
    const file = pka2xml.xor(pka2xml.compress(utf8(xml)));
    expect(decryptPkt(file)).toEqual({ ok: true, xml, format: 'legacy' });
  });

  it('leaves the input bytes untouched', () => {
    const file = encryptPkt(xml);
    const copy = file.slice();
    decryptPkt(file);
    expect(file).toEqual(copy);
  });
});

describe('decryptPkt errors', () => {
  it('reports too-short below the smallest possible file', () => {
    expect(decryptPkt(new Uint8Array(0))).toEqual({
      ok: false,
      error: { kind: 'too-short', length: 0 },
    });
    expect(decryptPkt(new Uint8Array(11))).toEqual({
      ok: false,
      error: { kind: 'too-short', length: 11 },
    });
  });

  it('reports bad-tag for bytes that are neither format', () => {
    const noise = Uint8Array.from({ length: 1000 }, (_, i) => (i * 73 + 41) & 0xff);
    expect(decryptPkt(noise)).toEqual({ ok: false, error: { kind: 'bad-tag' } });
  });

  it('reports bad-tag when one byte of a modern file changes', () => {
    const file = encryptPkt(xml);
    file[file.length >> 1]! ^= 0x01;
    expect(decryptPkt(file)).toEqual({ ok: false, error: { kind: 'bad-tag' } });
  });

  it('reports bad-zlib when an authentic modern payload is not zlib', () => {
    const file = pka2xml.encrypt(pka2xml.xor(new Uint8Array(64).fill(0x41)));
    expect(decryptPkt(file)).toMatchObject({
      ok: false,
      error: { kind: 'bad-zlib', format: 'modern' },
    });
  });

  it('reports bad-zlib when a legacy zlib header is followed by a broken stream', () => {
    // 0xff starts a deflate block of the reserved type 3.
    const payload = Uint8Array.from([0, 0, 1, 0, 0x78, 0x9c, ...Array<number>(20).fill(0xff)]);
    expect(decryptPkt(pka2xml.xor(payload))).toMatchObject({
      ok: false,
      error: { kind: 'bad-zlib', format: 'legacy' },
    });
  });
});
