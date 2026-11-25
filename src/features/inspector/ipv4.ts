import type { z } from 'zod';
import {
  err,
  formatSubnetMask,
  Ipv4Address,
  ok,
  PrefixLength,
  SubnetMask,
  type Ipv4Cidr,
  type Result,
} from '@/model';

function firstIssue(error: z.ZodError): string {
  return error.issues[0]?.message ?? 'Invalid value';
}

function toUint32(address: string): number {
  return address.split('.').reduce((acc, octet) => acc * 256 + Number(octet), 0) >>> 0;
}

function fromUint32(value: number): Ipv4Address {
  return Ipv4Address.parse([24, 16, 8, 0].map((shift) => (value >>> shift) & 0xff).join('.'));
}

function maskBits(prefixLength: number): number {
  return prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0;
}

export function networkOf({ address, prefixLength }: Ipv4Cidr): Ipv4Address {
  return fromUint32((toUint32(address) & maskBits(prefixLength)) >>> 0);
}

export function inSubnet(cidr: Ipv4Cidr, address: Ipv4Address): boolean {
  const mask = maskBits(cidr.prefixLength);
  return ((toUint32(cidr.address) ^ toUint32(address)) & mask) === 0;
}

export function formatCidr(cidr: Ipv4Cidr): string {
  return `${cidr.address}/${cidr.prefixLength}`;
}

/** The classful default Packet Tracer fills in for an address typed with no mask. */
export function classfulMask(text: string): string | undefined {
  const parsed = Ipv4Address.safeParse(text.trim());
  if (!parsed.success) return undefined;
  const first = Number(parsed.data.split('.')[0]);
  const prefix = first < 128 ? 8 : first < 192 ? 16 : first < 224 ? 24 : undefined;
  return prefix === undefined ? undefined : formatSubnetMask(PrefixLength.parse(prefix));
}

/** Accepts `255.255.255.0`, `/24` or `24`. */
export function parseMask(text: string): Result<PrefixLength, string> {
  const prefix = /^\/?(\d{1,2})$/.exec(text)?.[1];
  const parsed = prefix ? PrefixLength.safeParse(Number(prefix)) : SubnetMask.safeParse(text);
  return parsed.success ? ok(parsed.data) : err(firstIssue(parsed.error));
}

export type AddressErrors = { address?: string; mask?: string };

/**
 * An interface address from two fields. Both empty means "no address". An empty mask takes the
 * classful default, which the forms show as the mask placeholder.
 */
export function parseInterfaceAddress(
  addressText: string,
  maskText: string,
): Result<Ipv4Cidr | undefined, AddressErrors> {
  const [addressInput, maskInput] = [addressText.trim(), maskText.trim()];
  if (!addressInput && !maskInput) return ok(undefined);
  if (!addressInput) return err({ address: 'Enter an IP address for this mask' });

  const address = Ipv4Address.safeParse(addressInput);
  const maskOrDefault = maskInput || classfulMask(addressInput);
  const mask = maskOrDefault ? parseMask(maskOrDefault) : err('Enter a subnet mask');
  const errors: AddressErrors = {
    ...(address.success ? {} : { address: firstIssue(address.error) }),
    ...(mask.ok ? {} : { mask: mask.error }),
  };
  if (!address.success || !mask.ok) return err(errors);

  const cidr = { address: address.data, prefixLength: mask.value };
  if (cidr.prefixLength <= 30) {
    const network = toUint32(networkOf(cidr));
    const broadcast = (network | ~maskBits(cidr.prefixLength)) >>> 0;
    const value = toUint32(cidr.address);
    if (value === network) return err({ address: 'This is the network address of the subnet' });
    if (value === broadcast) return err({ address: 'This is the broadcast address of the subnet' });
  }
  return ok(cidr);
}

/** An optional single address, such as a gateway or DNS server. */
export function parseOptionalAddress(text: string): Result<Ipv4Address | undefined, string> {
  const input = text.trim();
  if (!input) return ok(undefined);
  const parsed = Ipv4Address.safeParse(input);
  return parsed.success ? ok(parsed.data) : err(firstIssue(parsed.error));
}
