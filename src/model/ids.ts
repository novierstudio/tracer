import { z } from 'zod';
import { MacAddress } from './values';

const idSchema = (prefix: string, label: string) =>
  z.string().regex(new RegExp(`^${prefix}_[0-9A-Za-z]{1,32}$`), `Invalid ${label} id`);

export const DeviceId = idSchema('dev', 'device').brand<'DeviceId'>();
export type DeviceId = z.infer<typeof DeviceId>;

export const LinkId = idSchema('lnk', 'link').brand<'LinkId'>();
export type LinkId = z.infer<typeof LinkId>;

export const AnnotationId = idSchema('ann', 'annotation').brand<'AnnotationId'>();
export type AnnotationId = z.infer<typeof AnnotationId>;

export type IdSource = {
  deviceId(): DeviceId;
  linkId(): LinkId;
  annotationId(): AnnotationId;
  macAddress(): MacAddress;
};

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

export function randomSeed(): number {
  const [seed = 0] = crypto.getRandomValues(new Uint32Array(1));
  return seed;
}

export function createIdSource(seed: number = randomSeed()): IdSource {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
  const token = () => Array.from({ length: 10 }, () => ALPHABET.charAt(next() % 62)).join('');
  const octet = (value: number) => (value & 0xff).toString(16).padStart(2, '0');

  return {
    deviceId: () => DeviceId.parse(`dev_${token()}`),
    linkId: () => LinkId.parse(`lnk_${token()}`),
    annotationId: () => AnnotationId.parse(`ann_${token()}`),
    macAddress: () => {
      const locallyAdministeredUnicast = (next() & 0xfc) | 0x02;
      const rest = Array.from({ length: 5 }, () => octet(next()));
      return MacAddress.parse([octet(locallyAdministeredUnicast), ...rest].join(':'));
    },
  };
}
