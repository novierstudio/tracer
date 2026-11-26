import {
  formatSubnetMask,
  type AccessList,
  type AclAddress,
  type AclName,
  type AclPort,
  type AclProtocol,
  type ExtendedAclEntry,
  type Ipv4Address,
  type NatConfig,
  type StandardAclEntry,
} from '../../model';
import type { AclHits, NatEndpoint, NatTranslationEntry } from '../../engine/api';
import type { IosDevice } from './context';

// How access lists and NAT print, in running-config and in show commands.

export type AclType = AccessList['type'];
export type StandardRule = Extract<StandardAclEntry, { kind: 'rule' }>;
export type ExtendedRule = Extract<ExtendedAclEntry, { kind: 'rule' }>;
export type AclEntry = StandardAclEntry | ExtendedAclEntry;

/** `any`: every address. */
export const ANY: AclAddress = {
  address: '0.0.0.0' as Ipv4Address,
  wildcard: '255.255.255.255' as Ipv4Address,
};
/** The wildcard of `host A`: every bit must match. */
export const NO_WILDCARD = '0.0.0.0' as Ipv4Address;

/** The well-known ports IOS names in access lists, and prints by name. */
export const PORT_NAMES: Readonly<Record<'tcp' | 'udp', Readonly<Record<string, number>>>> = {
  tcp: { 'ftp-data': 20, ftp: 21, telnet: 23, smtp: 25, domain: 53, www: 80, pop3: 110 },
  udp: { domain: 53, bootps: 67, bootpc: 68, tftp: 69, ntp: 123, snmp: 161, rip: 520 },
};

/** The access list type a number names: 1 to 99 standard, 100 to 199 extended. */
export function numberedType(name: string): AclType | undefined {
  if (!/^\d+$/.test(name)) return undefined;
  const n = Number(name);
  return n >= 1 && n <= 99 ? 'standard' : n >= 100 && n <= 199 ? 'extended' : undefined;
}

export function formatAddress({ address, wildcard }: AclAddress, standard: boolean): string {
  if (wildcard === ANY.wildcard) return 'any';
  if (wildcard === NO_WILDCARD) return standard ? address : `host ${address}`;
  return `${address} ${wildcard}`;
}

function formatPortNumber(port: number, protocol: 'tcp' | 'udp'): string {
  const name = Object.entries(PORT_NAMES[protocol]).find(([, n]) => n === port)?.[0];
  return name ?? String(port);
}

function formatPort(match: AclPort | undefined, protocol: AclProtocol): string[] {
  if (!match || (protocol !== 'tcp' && protocol !== 'udp')) return [];
  if (match.op === 'range') {
    return [
      `range ${formatPortNumber(match.first, protocol)} ${formatPortNumber(match.last, protocol)}`,
    ];
  }
  return [`${match.op} ${formatPortNumber(match.port, protocol)}`];
}

export function formatExtended(rule: ExtendedRule): string {
  return [
    rule.action,
    rule.protocol,
    formatAddress(rule.source, false),
    ...formatPort(rule.sourcePort, rule.protocol),
    formatAddress(rule.destination, false),
    ...formatPort(rule.destinationPort, rule.protocol),
    ...(rule.icmpType ? [rule.icmpType] : []),
  ].join(' ');
}

/** An entry as running-config writes it after `access-list N` or inside `ip access-list`. */
function entryLine(type: AclType, entry: AclEntry): string {
  if (entry.kind === 'remark') return `remark ${entry.text}`;
  return type === 'standard'
    ? `${entry.action} ${formatAddress((entry as StandardRule).source, true)}`
    : formatExtended(entry as ExtendedRule);
}

/**
 * The device's access lists as running-config lines: named lists as `ip access-list` blocks, then
 * numbered lists as `access-list` lines. Empty when it has none.
 */
export function accessListLines(device: IosDevice): string[] {
  const named: string[] = [];
  const numbered: string[] = [];
  for (const [name, list] of Object.entries(device.config.accessLists ?? {})) {
    const entries: readonly AclEntry[] = list.entries;
    if (numberedType(name)) {
      numbered.push(
        ...entries.map((entry) => `access-list ${name} ${entryLine(list.type, entry)}`),
      );
    } else {
      named.push(
        `ip access-list ${list.type} ${name}`,
        ...entries.map((entry) => ` ${entryLine(list.type, entry)}`),
        '!',
      );
    }
  }
  return [...named, ...numbered, ...(numbered.length > 0 ? ['!'] : [])];
}

const matches = (count: number) => (count === 1 ? ' (1 match)' : ` (${count} matches)`);

/** A standard rule as `show access-lists` writes it: a network shows its wildcard bits. */
function showStandard({ action, source }: StandardRule): string {
  const { address, wildcard } = source;
  const what =
    wildcard === ANY.wildcard || wildcard === NO_WILDCARD
      ? formatAddress(source, true)
      : `${address}, wildcard bits ${wildcard}`;
  return `${action} ${what}`;
}

/**
 * `show access-lists`: every list, or only `only`, with each rule numbered 10, 20 and so on, as
 * IOS numbers them, and how many packets it matched. Remarks are left out.
 */
export function showAccessLists(
  hits: AclHits | undefined,
  device: IosDevice,
  only?: AclName,
): string[] {
  const out: string[] = [];
  for (const [name, list] of Object.entries(device.config.accessLists ?? {})) {
    if (only !== undefined && name !== only) continue;
    const kind = list.type === 'standard' ? 'Standard' : 'Extended';
    out.push(`${kind} IP access list ${name}`);
    const counts = hits?.[name] ?? [];
    let sequence = 0;
    (list.entries as readonly AclEntry[]).forEach((entry, index) => {
      if (entry.kind === 'remark') return;
      sequence += 10;
      const text =
        list.type === 'standard'
          ? showStandard(entry as StandardRule)
          : formatExtended(entry as ExtendedRule);
      const count = counts[index] ?? 0;
      out.push(`    ${sequence} ${text}${count > 0 ? matches(count) : ''}`);
    });
  }
  return out;
}

/** The router's NAT lines in running-config: pools, then dynamic rules, then static mappings. */
export function natLines({ pools, statics, dynamic }: NatConfig): string[] {
  return [
    ...Object.entries(pools).map(
      ([name, { first, last, prefixLength }]) =>
        `ip nat pool ${name} ${first} ${last} netmask ${formatSubnetMask(prefixLength)}`,
    ),
    ...dynamic.map(({ acl, to, overload }) => {
      const target = to.kind === 'pool' ? `pool ${to.pool}` : `interface ${to.interface}`;
      return `ip nat inside source list ${acl} ${target}${overload ? ' overload' : ''}`;
    }),
    ...statics.map(({ local, global }) => `ip nat inside source static ${local} ${global}`),
  ];
}

const PROTOCOL_NAMES: Readonly<Record<number, string>> = { 1: 'icmp', 6: 'tcp', 17: 'udp' };

const endpoint = (e: NatEndpoint | undefined) =>
  e === undefined ? '---' : e.port === undefined ? e.address : `${e.address}:${e.port}`;

/** The translations from config alone: the static mappings. */
const staticTranslations = (device: IosDevice): NatTranslationEntry[] =>
  ((device.kind === 'router' && device.config.nat?.statics) || []).map((m) => ({
    insideGlobal: { address: m.global },
    insideLocal: { address: m.local },
  }));

/** `show ip nat translations`, IOS's columns. Without a simulation, only static mappings show. */
export function showIpNatTranslations(
  translations: readonly NatTranslationEntry[] | undefined,
  device: IosDevice,
): string[] {
  const rows = translations ?? staticTranslations(device);
  if (rows.length === 0) return [];
  const row = (cells: readonly string[]) =>
    cells
      .map((cell, i) => (i === 0 ? cell.padEnd(5) : cell.padEnd(22)))
      .join('')
      .trimEnd();
  return [
    row(['Pro', 'Inside global', 'Inside local', 'Outside local', 'Outside global']),
    ...rows.map((t) =>
      row([
        t.protocol === undefined ? '---' : (PROTOCOL_NAMES[t.protocol] ?? String(t.protocol)),
        endpoint(t.insideGlobal),
        endpoint(t.insideLocal),
        endpoint(t.outside),
        endpoint(t.outside),
      ]),
    ),
  ];
}
