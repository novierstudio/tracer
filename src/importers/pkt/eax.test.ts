// @vitest-environment node
/// <reference types="node" />
import { createCipheriv } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eaxOpen, eaxSeal } from './eax';
import { twofish, type BlockCipher } from './twofish';

const fromHex = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], (b) => parseInt(b, 16));
const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();

/** AES-128 from Node, so EAX can be checked against the published AES vectors. */
function aes128(key: Uint8Array): BlockCipher {
  return {
    encryptBlock(block) {
      const cipher = createCipheriv('aes-128-ecb', key, null).setAutoPadding(false);
      block.set(cipher.update(block.subarray(0, 16)));
    },
  };
}

// The ten AES-EAX vectors from the EAX paper (Bellare, Rogaway, Wagner), appendix.
// "ciphertext" is the ciphertext followed by the 16-byte tag.
// prettier-ignore
const paperVectors = [
  ['', '233952DEE4D5ED5F9B9C6D6FF80FF478', '62EC67F9C3A4A407FCB2A8C49031A8B3', '6BFB914FD07EAE6B', 'E037830E8389F27B025A2D6527E79D01'],
  ['F7FB', '91945D3F4DCBEE0BF45EF52255F095A4', 'BECAF043B0A23D843194BA972C66DEBD', 'FA3BFD4806EB53FA', '19DD5C4C9331049D0BDAB0277408F67967E5'],
  ['1A47CB4933', '01F74AD64077F2E704C0F60ADA3DD523', '70C3DB4F0D26368400A10ED05D2BFF5E', '234A3463C1264AC6', 'D851D5BAE03A59F238A23E39199DC9266626C40F80'],
  ['481C9E39B1', 'D07CF6CBB7F313BDDE66B727AFD3C5E8', '8408DFFF3C1A2B1292DC199E46B7D617', '33CCE2EABFF5A79D', '632A9D131AD4C168A4225D8E1FF755939974A7BEDE'],
  ['40D0C07DA5E4', '35B6D0580005BBC12B0587124557D2C2', 'FDB6B06676EEDC5C61D74276E1F8E816', 'AEB96EAEBE2970E9', '071DFE16C675CB0677E536F73AFE6A14B74EE49844DD'],
  ['4DE3B35C3FC039245BD1FB7D', 'BD8E6E11475E60B268784C38C62FEB22', '6EAC5C93072D8E8513F750935E46DA1B', 'D4482D1CA78DCE0F', '835BB4F15D743E350E728414ABB8644FD6CCB86947C5E10590210A4F'],
  ['8B0A79306C9CE7ED99DAE4F87F8DD61636', '7C77D6E813BED5AC98BAA417477A2E7D', '1A8C98DCD73D38393B2BF1569DEEFC19', '65D2017990D62528', '02083E3979DA014812F59F11D52630DA30137327D10649B0AA6E1C181DB617D7F2'],
  ['1BDA122BCE8A8DBAF1877D962B8592DD2D56', '5FFF20CAFAB119CA2FC73549E20F5B0D', 'DDE59B97D722156D4D9AFF2BC7559826', '54B9F04E6A09189A', '2EC47B2C4954A489AFC7BA4897EDCDAE8CC33B60450599BD02C96382902AEF7F832A'],
  ['6CF36720872B8513F6EAB1A8A44438D5EF11', 'A4A4782BCFFD3EC5E7EF6D8C34A56123', 'B781FCF2F75FA5A8DE97A9CA48E522EC', '899A175897561D7E', '0DE18FD0FDD91E7AF19F1D8EE8733938B1E8E7F6D2231618102FDB7FE55FF1991700'],
  ['CA40D7446E545FFAED3BD12A740A659FFBBB3CEAB7', '8395FCF1E95BEBD697BD010BC766AAC3', '22E7ADD93CFC6393C57EC0B3C17D6B44', '126735FCC320D25A', 'CB8920F87A6C75CFF39627B56E3ED197C552D295A7CFC46AFC253B4652B1AF3795B124AB6E'],
] as const;

describe('EAX against the published AES vectors', () => {
  it.each(paperVectors)('seals %s', (msg, key, nonce, header, sealed) => {
    const cipher = aes128(fromHex(key));
    expect(toHex(eaxSeal(cipher, fromHex(nonce), fromHex(header), fromHex(msg)))).toBe(sealed);
    expect(eaxOpen(cipher, fromHex(nonce), fromHex(header), fromHex(sealed))).toEqual(fromHex(msg));
  });
});

describe('EAX over Twofish', () => {
  const cipher = twofish(new Uint8Array(16).fill(0x89));
  const nonce = new Uint8Array(16).fill(0x10);
  const none = new Uint8Array(0);
  // Lengths around block boundaries, where CMAC padding and CTR tails change.
  const lengths = [0, 1, 15, 16, 17, 31, 32, 33, 1000];

  it.each(lengths)('round-trips %i bytes', (length) => {
    const plaintext = Uint8Array.from({ length }, (_, i) => (i * 31 + 7) & 0xff);
    const sealed = eaxSeal(cipher, nonce, none, plaintext);
    expect(sealed.length).toBe(length + 16);
    expect(eaxOpen(cipher, nonce, none, sealed)).toEqual(plaintext);
  });

  it('rejects a flipped bit anywhere in the ciphertext or tag', () => {
    const sealed = eaxSeal(cipher, nonce, none, new TextEncoder().encode('<PACKETTRACER5/>'));
    for (let i = 0; i < sealed.length; i++) {
      const tampered = sealed.slice();
      tampered[i]! ^= 0x01;
      expect(eaxOpen(cipher, nonce, none, tampered)).toBeNull();
    }
  });

  it('rejects the wrong nonce, header or key', () => {
    const sealed = eaxSeal(cipher, nonce, none, new Uint8Array(40));
    expect(eaxOpen(cipher, new Uint8Array(16), none, sealed)).toBeNull();
    expect(eaxOpen(cipher, nonce, new Uint8Array(1), sealed)).toBeNull();
    expect(eaxOpen(twofish(new Uint8Array(16)), nonce, none, sealed)).toBeNull();
  });

  it('rejects input shorter than a tag', () => {
    expect(eaxOpen(cipher, nonce, none, new Uint8Array(15))).toBeNull();
  });
});
