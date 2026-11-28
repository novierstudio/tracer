// How IOS stores passwords in a running-config.
//   Type 7: `service password-encryption`. A Vigenère-style XOR with a fixed key, so it reverses.
//   Type 5: `enable secret`. MD5-crypt ($1$salt$hash), the FreeBSD scheme IOS uses.
import { Md5CryptHash } from '../model';
import { md5 } from '../model/md5';

const TYPE7_KEY = 'dsfd;kfoA,.iyewrkldJKDHSUBsgvca69834ncxv9873254k;fg87';

/** IOS picks a random seed. Deriving it from the text keeps the CLI pure. */
export function encodeType7(text: string): string {
  const seed = [...text].reduce((sum, c) => sum + c.charCodeAt(0), 0) % 16;
  const body = [...text].map((c, i) =>
    (c.charCodeAt(0) ^ TYPE7_KEY.charCodeAt((seed + i) % TYPE7_KEY.length))
      .toString(16)
      .toUpperCase()
      .padStart(2, '0'),
  );
  return String(seed).padStart(2, '0') + body.join('');
}

export function decodeType7(encoded: string): string | undefined {
  const match = /^(\d{2})((?:[0-9a-f]{2})+)$/i.exec(encoded);
  if (!match) return undefined;
  const seed = Number(match[1]);
  if (seed >= TYPE7_KEY.length) return undefined;
  const bytes = match[2]!.match(/../g)!.map((pair) => parseInt(pair, 16));
  const text = bytes.map((b, i) =>
    String.fromCharCode(b ^ TYPE7_KEY.charCodeAt((seed + i) % TYPE7_KEY.length)),
  );
  return text.join('');
}

const ITOA64 = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function to64(value: number, count: number): string {
  let out = '';
  for (let i = 0; i < count; i++, value >>>= 6) out += ITOA64[value & 0x3f];
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const utf8 = (text: string) => new TextEncoder().encode(text);

export function md5Crypt(password: string, salt: string): Md5CryptHash {
  const pw = utf8(password);
  const magic = utf8('$1$');
  const saltBytes = utf8(salt.slice(0, 8));

  const alternate = md5(concat(pw, saltBytes, pw));
  const parts: Uint8Array[] = [pw, magic, saltBytes];
  for (let left = pw.length; left > 0; left -= 16)
    parts.push(alternate.subarray(0, Math.min(16, left)));
  for (let i = pw.length; i > 0; i >>>= 1)
    parts.push(i & 1 ? new Uint8Array(1) : pw.subarray(0, 1));
  let final = md5(concat(...parts));

  for (let i = 0; i < 1000; i++) {
    final = md5(
      concat(
        i & 1 ? pw : final,
        i % 3 ? saltBytes : new Uint8Array(0),
        i % 7 ? pw : new Uint8Array(0),
        i & 1 ? final : pw,
      ),
    );
  }

  const f = final;
  const hash =
    to64((f[0]! << 16) | (f[6]! << 8) | f[12]!, 4) +
    to64((f[1]! << 16) | (f[7]! << 8) | f[13]!, 4) +
    to64((f[2]! << 16) | (f[8]! << 8) | f[14]!, 4) +
    to64((f[3]! << 16) | (f[9]! << 8) | f[15]!, 4) +
    to64((f[4]! << 16) | (f[10]! << 8) | f[5]!, 4) +
    to64(f[11]!, 2);
  return Md5CryptHash.parse(`$1$${salt.slice(0, 8)}$${hash}`);
}

/** IOS draws a random 4-character salt. Deriving it from the password keeps the CLI pure. */
export function hashSecret(password: string): Md5CryptHash {
  const digest = md5(utf8(password));
  return md5Crypt(password, to64((digest[0]! << 16) | (digest[1]! << 8) | digest[2]!, 4));
}

export function verifySecret(password: string, hash: Md5CryptHash): boolean {
  const salt = hash.split('$')[2] ?? '';
  return md5Crypt(password, salt) === hash;
}
