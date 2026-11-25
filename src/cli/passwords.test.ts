import { describe, expect, it } from 'vitest';
import { decodeType7, encodeType7, hashSecret, md5Crypt, verifySecret } from './passwords';

describe('type 7 passwords', () => {
  it.each([
    ['0822455D0A16', 'cisco'],
    ['094F471A1A0A', 'cisco'],
    ['070C285F4D06', 'cisco'],
  ])('decodes %s to %s', (encoded, text) => {
    expect(decodeType7(encoded)).toBe(text);
  });

  it.each(['cisco', 'class', 'p@ss word', 'a'])('round-trips %j', (text) => {
    expect(decodeType7(encodeType7(text))).toBe(text);
  });

  it.each(['', '08', '0822455D0A1', 'zz22455D0A16', '9922'])('rejects %j', (encoded) => {
    expect(decodeType7(encoded)).toBeUndefined();
  });
});

describe('MD5-crypt secrets', () => {
  // Expected values from `openssl passwd -1 -salt <salt> <password>`.
  it.each([
    ['cisco', 'mERr', '$1$mERr$hx5rVt7rPNoS4wqbXKX7m0'],
    ['class', 'abcd', '$1$abcd$8jqYy27Wek90Tm6oQKdzX0'],
    ['x', '', '$1$$LP5.V3ajGqHDdXW6XwZQy.'],
    ['a much longer password than usual', '12345678', '$1$12345678$Yrw7s8SU4ySFDoB9tbmSP.'],
  ])('hashes %j with salt %j', (password, salt, expected) => {
    expect(md5Crypt(password, salt)).toBe(expected);
  });

  it('verifies the password a hash was made from, and only that one', () => {
    const hash = hashSecret('class');

    expect(hashSecret('class')).toBe(hash);
    expect(verifySecret('class', hash)).toBe(true);
    expect(verifySecret('Class', hash)).toBe(false);
  });
});
