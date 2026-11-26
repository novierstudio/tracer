import type {
  AccessList,
  AclAddress,
  AclIcmpType,
  AclName,
  AclPort,
  AclProtocol,
  Device,
  ExtendedAclEntry,
  Ipv4Address,
  RoutedInterface,
  StandardAclEntry,
} from '@/model';
import { IP_PROTOCOL, type IcmpMessage, type Ipv4Packet, type Ipv4Payload } from '../pdu';
import type { IpContext } from './context';
import type { IpInterface } from './interfaces';
import { matchesWildcard } from './ipv4';

/** The IP protocol number each protocol an extended entry names stands for. `ip` matches any. */
export const ACL_PROTOCOL: Readonly<Record<Exclude<AclProtocol, 'ip'>, number>> = {
  icmp: 1,
  tcp: 6,
  udp: 17,
};

const ICMP_TYPE_OF: Readonly<Record<AclIcmpType, IcmpMessage['type']>> = {
  echo: 'echo-request',
  'echo-reply': 'echo-reply',
  unreachable: 'destination-unreachable',
  'time-exceeded': 'time-exceeded',
};

/** What an access list reads from a packet. */
export type Flow = {
  /** The IP protocol number. */
  readonly protocol: number;
  readonly src: Ipv4Address;
  readonly dst: Ipv4Address;
  /** TCP and UDP only. */
  readonly srcPort?: number;
  readonly dstPort?: number;
  /** ICMP only. */
  readonly icmpType?: IcmpMessage['type'];
};

export type Ports = { readonly srcPort: number; readonly dstPort: number };

/**
 * The ports a packet's transport header carries: TCP's (6) or UDP's (17). A payload's kind stands
 * in for its IP protocol number (see pdu.ts).
 */
export function transportPorts(payload: Ipv4Payload): Ports | undefined {
  switch (payload.kind) {
    case 'tcp':
    case 'udp':
      return { srcPort: payload.srcPort, dstPort: payload.dstPort };
    default:
      return undefined;
  }
}

export function flowOf({ src, dst, payload }: Ipv4Packet): Flow {
  return {
    protocol: IP_PROTOCOL[payload.kind],
    src,
    dst,
    ...transportPorts(payload),
    ...(payload.kind === 'icmp' && { icmpType: payload.type }),
  };
}

const addressMatches = ({ address, wildcard }: AclAddress, candidate: Ipv4Address) =>
  matchesWildcard(candidate, address, wildcard);

function portMatches(match: AclPort | undefined, port: number | undefined): boolean {
  if (!match) return true;
  if (port === undefined) return false;
  switch (match.op) {
    case 'eq':
      return port === match.port;
    case 'neq':
      return port !== match.port;
    case 'gt':
      return port > match.port;
    case 'lt':
      return port < match.port;
    case 'range':
      return port >= match.first && port <= match.last;
  }
}

type ExtendedRule = Extract<ExtendedAclEntry, { kind: 'rule' }>;

function extendedMatches(rule: ExtendedRule, flow: Flow): boolean {
  if (rule.protocol !== 'ip' && ACL_PROTOCOL[rule.protocol] !== flow.protocol) return false;
  if (rule.icmpType && ICMP_TYPE_OF[rule.icmpType] !== flow.icmpType) return false;
  return (
    addressMatches(rule.source, flow.src) &&
    addressMatches(rule.destination, flow.dst) &&
    portMatches(rule.sourcePort, flow.srcPort) &&
    portMatches(rule.destinationPort, flow.dstPort)
  );
}

const ruleMatches = (
  list: AccessList,
  entry: StandardAclEntry | ExtendedAclEntry,
  flow: Flow,
): boolean => {
  if (entry.kind === 'remark') return false;
  return list.type === 'standard'
    ? addressMatches((entry as Extract<StandardAclEntry, { kind: 'rule' }>).source, flow.src)
    : extendedMatches(entry as ExtendedRule, flow);
};

/**
 * The first entry of `list` that matches the flow, by its index among the entries, or undefined
 * when none does and the implicit deny at the end of every list applies.
 */
export function firstMatch(list: AccessList, flow: Flow): number | undefined {
  const entries: readonly (StandardAclEntry | ExtendedAclEntry)[] = list.entries;
  const index = entries.findIndex((entry) => ruleMatches(list, entry, flow));
  return index === -1 ? undefined : index;
}

/** The action of the entry at `index`, or deny for the implicit deny. */
const actionAt = (list: AccessList, index: number | undefined) => {
  const entry = index === undefined ? undefined : list.entries[index];
  return entry?.kind === 'rule' ? entry.action : 'deny';
};

/** The device's access list `name`, if the config defines it. */
export const accessList = (device: Device, name: AclName): AccessList | undefined =>
  device.kind === 'router' || device.kind === 'switch'
    ? device.config.accessLists?.[name]
    : undefined;

/**
 * Whether the device's list `name` permits the flow, counting the hit on the entry that decided.
 * A list the config does not define permits nothing.
 */
export function permits(ctx: IpContext, name: AclName, flow: Flow): boolean {
  const list = accessList(ctx.device, name);
  if (!list) return false;
  const index = firstMatch(list, flow);
  if (index !== undefined) {
    const hits = ctx.state.aclHits.get(name) ?? [];
    while (hits.length <= index) hits.push(0);
    hits[index]! += 1;
    ctx.state.aclHits.set(name, hits);
  }
  return actionAt(list, index) === 'permit';
}

type FilterSettings = Pick<RoutedInterface, 'accessGroupIn' | 'accessGroupOut' | 'nat'>;

/**
 * The access groups and NAT role of one of the device's interfaces, by name. Any interface that
 * routes can have them: a router's ports, subinterfaces and loopbacks, and a switch's VLAN
 * interfaces. A host has none.
 */
export function filterSettings(device: Device, iface: IpInterface): FilterSettings | undefined {
  if (device.kind !== 'router' && device.kind !== 'switch') return undefined;
  const { config } = device;
  const tables = [
    config.interfaces,
    'subinterfaces' in config ? config.subinterfaces : {},
    config.virtualInterfaces,
  ] as readonly Readonly<Record<string, FilterSettings | undefined>>[];
  return tables.map((table) => table[iface.name]).find((found) => found !== undefined);
}

export type Direction = 'in' | 'out';

/**
 * The access list on the interface in `direction` that denies the packet, counting the hit, or
 * undefined when the packet may pass. An access group that names a list the config does not
 * define lets everything through, as on IOS.
 */
export function deniedBy(
  ctx: IpContext,
  iface: IpInterface,
  direction: Direction,
  packet: Ipv4Packet,
): AclName | undefined {
  const settings = filterSettings(ctx.device, iface);
  const name = direction === 'in' ? settings?.accessGroupIn : settings?.accessGroupOut;
  if (name === undefined || !accessList(ctx.device, name)) return undefined;
  return permits(ctx, name, flowOf(packet)) ? undefined : name;
}

/**
 * Forgets the hit counters of lists the config no longer has, so a list typed in again after
 * `no access-list` counts from zero.
 */
export function forgetRemovedLists(ctx: IpContext) {
  for (const name of [...ctx.state.aclHits.keys()]) {
    if (!accessList(ctx.device, name)) ctx.state.aclHits.delete(name);
  }
}

/** Each list's hit counters, by entry index. Entries past the end have no hits yet. */
export type AclHits = Readonly<Record<AclName, readonly number[]>>;

export const aclHits = (ctx: IpContext): AclHits => Object.fromEntries(ctx.state.aclHits);
