import type { Ipv4Address, NatConfig, NatDynamic } from '@/model';
import { ms, type SimDuration, type SimTime } from '../core/time';
import { IP_PROTOCOL, type Ipv4Packet, type Ipv4Payload } from '../pdu';
import { filterSettings, flowOf, permits, transportPorts } from './acl';
import { interfacesOf, type IpContext } from './context';
import type { IpInterface } from './interfaces';
import { ipv4ToUint32, uint32ToIpv4 } from './ipv4';

/** One side of a translation: an address, and for PAT a port. */
export type NatEndpoint = { readonly address: Ipv4Address; readonly port?: number };

/** Dynamic NAT without overload: an inside host borrows a pool address while it keeps talking. */
export type NatBinding = {
  readonly local: Ipv4Address;
  readonly global: Ipv4Address;
  lastUsed: SimTime;
};

/**
 * PAT: one conversation of an inside host, told apart from the others on the same inside global
 * address by its port. An ICMP echo's identifier stands in for the port.
 */
export type NatFlow = {
  /** The IP protocol number. */
  readonly protocol: number;
  readonly inside: NatEndpoint;
  readonly global: NatEndpoint;
  /** The outside host, as the inside host addresses it and as it sees the router. */
  readonly outside: NatEndpoint;
  lastUsed: SimTime;
};

/** A router's dynamic translations. Static ones live in its config. */
export type NatTable = { bindings: NatBinding[]; flows: NatFlow[] };

export const emptyNatTable = (): NatTable => ({ bindings: [], flows: [] });

/**
 * How long a translation lasts once its traffic stops, by IOS's defaults: a day for an address
 * binding and for TCP, 5 minutes for UDP and a minute for ICMP.
 */
export const NAT_TIMEOUTS = {
  binding: ms(86_400_000),
  [IP_PROTOCOL.icmp]: ms(60_000),
  [IP_PROTOCOL.tcp]: ms(86_400_000),
  [IP_PROTOCOL.udp]: ms(300_000),
} as const satisfies Record<string, SimDuration>;

const flowTimeout = (protocol: number): SimDuration =>
  (NAT_TIMEOUTS as Record<number, SimDuration>)[protocol] ?? NAT_TIMEOUTS.binding;

/** The first port PAT hands out when a host's own port is taken, as IOS does. */
export const PAT_FIRST_PORT = 1024;
const LAST_PORT = 65535;

const natOf = (ctx: IpContext): NatConfig | undefined =>
  ctx.device.kind === 'router' ? ctx.device.config.nat : undefined;

const roleOf = (ctx: IpContext, iface: IpInterface) => filterSettings(ctx.device, iface)?.nat;

/** Drops translations whose time ran out. Called before the table is read or changed. */
function expire(ctx: IpContext) {
  const table = ctx.state.nat;
  const now = ctx.now;
  table.bindings = table.bindings.filter((b) => now - b.lastUsed < NAT_TIMEOUTS.binding);
  table.flows = table.flows.filter((f) => now - f.lastUsed < flowTimeout(f.protocol));
}

/**
 * The ports NAT tells conversations apart by: a TCP or UDP header's, or an echo's identifier,
 * which an ICMP echo carries on both sides. Undefined for anything else.
 */
function natPorts(payload: Ipv4Payload): { src: number; dst: number } | undefined {
  if (payload.kind === 'icmp') {
    const echo = payload.type === 'echo-request' || payload.type === 'echo-reply';
    return echo ? { src: payload.id, dst: payload.id } : undefined;
  }
  const ports = transportPorts(payload);
  return ports && { src: ports.srcPort, dst: ports.dstPort };
}

/** The payload with its source or destination port replaced. An echo has one identifier for both. */
function withPort(payload: Ipv4Payload, side: 'src' | 'dst', port: number): Ipv4Payload {
  switch (payload.kind) {
    case 'icmp':
      return payload.type === 'echo-request' || payload.type === 'echo-reply'
        ? { ...payload, id: port }
        : payload;
    case 'tcp':
      return side === 'src' ? { ...payload, srcPort: port } : { ...payload, dstPort: port };
    case 'udp':
      return side === 'src' ? { ...payload, srcPort: port } : { ...payload, dstPort: port };
    default:
      return payload;
  }
}

const sameEndpoint = (a: NatEndpoint, b: NatEndpoint) =>
  a.address === b.address && a.port === b.port;

/** The inside global addresses a dynamic rule lends: its pool's, or its interface's own. */
function globalsOf(ctx: IpContext, nat: NatConfig, rule: NatDynamic): Ipv4Address[] {
  if (rule.to.kind === 'interface') {
    const name = rule.to.interface;
    const iface = interfacesOf(ctx).find((candidate) => candidate.name === name);
    return iface ? [iface.cidr.address] : [];
  }
  const pool = nat.pools[rule.to.pool];
  if (!pool) return [];
  const addresses: Ipv4Address[] = [];
  for (let n = ipv4ToUint32(pool.first); n <= ipv4ToUint32(pool.last); n++) {
    addresses.push(uint32ToIpv4(n));
  }
  return addresses;
}

/** Lends a free pool address to `local`. Undefined when every address is out on loan. */
function bind(ctx: IpContext, nat: NatConfig, rule: NatDynamic, local: Ipv4Address) {
  const taken = new Set([
    ...ctx.state.nat.bindings.map((b) => b.global),
    ...nat.statics.map((m) => m.global),
  ]);
  const global = globalsOf(ctx, nat, rule).find((address) => !taken.has(address));
  if (global === undefined) return undefined;
  const binding: NatBinding = { local, global, lastUsed: ctx.now };
  ctx.state.nat.bindings.push(binding);
  return binding;
}

/**
 * A new PAT flow for `inside`. The host keeps the global endpoint it already has for the same
 * port, so every outside host sees it the same way. Otherwise it keeps its own port on the first
 * global address where that is free, or takes the lowest free port from 1024 up.
 */
function share(
  ctx: IpContext,
  globals: readonly Ipv4Address[],
  protocol: number,
  inside: NatEndpoint,
  outside: NatEndpoint,
): NatFlow | undefined {
  const flows = ctx.state.nat.flows.filter((f) => f.protocol === protocol);
  const known = flows.find((f) => sameEndpoint(f.inside, inside))?.global;
  const used = (address: Ipv4Address, port: number) =>
    flows.some((f) => f.global.address === address && f.global.port === port);
  let global = known;
  for (const address of globals) {
    if (global || inside.port === undefined) break;
    if (!used(address, inside.port)) global = { address, port: inside.port };
  }
  for (const address of globals) {
    for (let port = PAT_FIRST_PORT; !global && port <= LAST_PORT; port++) {
      if (!used(address, port)) global = { address, port };
    }
  }
  if (!global) return undefined;
  const flow: NatFlow = { protocol, inside, global, outside, lastUsed: ctx.now };
  ctx.state.nat.flows.push(flow);
  return flow;
}

/**
 * NAT on the way out: a packet from an inside interface leaving by an outside one gets an inside
 * global source. A static mapping wins, then a translation already in the table, then the first
 * dynamic rule whose access list permits the packet makes a new one. A packet no rule covers goes
 * out as it is. Returns undefined for a packet that must be dropped because its pool is empty.
 */
export function natOut(
  ctx: IpContext,
  packet: Ipv4Packet,
  from: IpInterface,
  to: IpInterface,
): Ipv4Packet | undefined {
  const nat = natOf(ctx);
  if (!nat || roleOf(ctx, from) !== 'inside' || roleOf(ctx, to) !== 'outside') return packet;
  expire(ctx);
  const table = ctx.state.nat;
  const fixed = nat.statics.find((mapping) => mapping.local === packet.src);
  if (fixed) return { ...packet, src: fixed.global };

  const protocol = IP_PROTOCOL[packet.payload.kind];
  const ports = natPorts(packet.payload);
  const rewrite = (global: NatEndpoint): Ipv4Packet => ({
    ...packet,
    src: global.address,
    payload:
      global.port === undefined ? packet.payload : withPort(packet.payload, 'src', global.port),
  });
  const inside: NatEndpoint = { address: packet.src, port: ports?.src };
  const flow = table.flows.find(
    (f) =>
      f.protocol === protocol && sameEndpoint(f.inside, inside) && f.outside.address === packet.dst,
  );
  if (flow) {
    flow.lastUsed = ctx.now;
    return rewrite(flow.global);
  }
  const binding = table.bindings.find((b) => b.local === packet.src);
  if (binding) {
    binding.lastUsed = ctx.now;
    return rewrite({ address: binding.global });
  }

  const rule = nat.dynamic.find((candidate) => permits(ctx, candidate.acl, flowOf(packet)));
  if (!rule) return packet;
  if (rule.overload) {
    if (!ports) return packet;
    const outside = {
      address: packet.dst,
      port: protocol === IP_PROTOCOL.icmp ? undefined : ports.dst,
    };
    const shared = share(ctx, globalsOf(ctx, nat, rule), protocol, inside, outside);
    if (shared) return rewrite(shared.global);
  } else {
    const lent = bind(ctx, nat, rule, packet.src);
    if (lent) return rewrite({ address: lent.global });
  }
  const what = rule.to.kind === 'pool' ? `pool ${rule.to.pool}` : `interface ${rule.to.interface}`;
  ctx.note(`Dropped a packet from ${packet.src}: NAT ${what} has no address or port left`);
  return undefined;
}

/** The local endpoint behind an inside global one, from a flow, a binding or a static mapping. */
function untranslate(
  ctx: IpContext,
  nat: NatConfig,
  protocol: number,
  global: NatEndpoint,
  outside: Ipv4Address,
): NatEndpoint | undefined {
  const table = ctx.state.nat;
  const flow = table.flows.find(
    (f) =>
      f.protocol === protocol && sameEndpoint(f.global, global) && f.outside.address === outside,
  );
  if (flow) {
    flow.lastUsed = ctx.now;
    return flow.inside;
  }
  const binding = table.bindings.find((b) => b.global === global.address);
  if (binding) {
    binding.lastUsed = ctx.now;
    return { address: binding.local };
  }
  const fixed = nat.statics.find((mapping) => mapping.global === global.address);
  return fixed && { address: fixed.local };
}

/**
 * NAT on the way in, before routing: a packet arriving on an outside interface for an inside
 * global address goes on to the inside host behind it. An ICMP error about a translated packet
 * has the packet it quotes translated back too, so a traceroute through PAT works. Anything else,
 * such as a ping to the router's own address, stays as it is.
 */
export function natIn(ctx: IpContext, packet: Ipv4Packet, from: IpInterface): Ipv4Packet {
  const nat = natOf(ctx);
  if (!nat || roleOf(ctx, from) !== 'outside') return packet;
  expire(ctx);
  const { payload } = packet;
  if (
    payload.kind === 'icmp' &&
    (payload.type === 'destination-unreachable' || payload.type === 'time-exceeded')
  ) {
    const quoted = payload.original;
    const ports = natPorts(quoted.payload);
    const global = { address: quoted.src, port: ports?.src };
    const local = untranslate(ctx, nat, IP_PROTOCOL[quoted.payload.kind], global, quoted.dst);
    if (!local) return packet;
    const original: Ipv4Packet = {
      ...quoted,
      src: local.address,
      payload:
        local.port === undefined ? quoted.payload : withPort(quoted.payload, 'src', local.port),
    };
    return { ...packet, dst: local.address, payload: { ...payload, original } };
  }
  const ports = natPorts(payload);
  const global = { address: packet.dst, port: ports?.dst };
  const local = untranslate(ctx, nat, IP_PROTOCOL[payload.kind], global, packet.src);
  if (!local) return packet;
  return {
    ...packet,
    dst: local.address,
    payload: local.port === undefined ? payload : withPort(payload, 'dst', local.port),
  };
}

/**
 * Whether the router answers ARP for `address` on `iface`, as IOS does for the inside global
 * addresses of its static mappings and pools on an outside interface. Without that a pool in the
 * outside interface's own subnet could not take replies.
 */
export function answersArpFor(ctx: IpContext, iface: IpInterface, address: Ipv4Address): boolean {
  const nat = natOf(ctx);
  if (!nat || roleOf(ctx, iface) !== 'outside') return false;
  if (nat.statics.some((mapping) => mapping.global === address)) return true;
  const n = ipv4ToUint32(address);
  return Object.values(nat.pools).some(
    (pool) => n >= ipv4ToUint32(pool.first) && n <= ipv4ToUint32(pool.last),
  );
}

/** One line of `show ip nat translations`. The outside columns are empty for an address mapping. */
export type NatTranslationEntry = {
  /** The IP protocol number of a PAT flow. Undefined for an address mapping. */
  readonly protocol?: number;
  readonly insideGlobal: NatEndpoint;
  readonly insideLocal: NatEndpoint;
  readonly outside?: NatEndpoint;
};

/** Every translation in force: static mappings, then address bindings, then PAT flows. */
export function natTranslations(ctx: IpContext): NatTranslationEntry[] {
  const nat = natOf(ctx);
  if (!nat) return [];
  const now = ctx.now;
  const statics = nat.statics.map((m) => ({
    insideGlobal: { address: m.global },
    insideLocal: { address: m.local },
  }));
  const bindings = ctx.state.nat.bindings
    .filter((b) => now - b.lastUsed < NAT_TIMEOUTS.binding)
    .map((b) => ({ insideGlobal: { address: b.global }, insideLocal: { address: b.local } }));
  const flows = ctx.state.nat.flows
    .filter((f) => now - f.lastUsed < flowTimeout(f.protocol))
    .map((f) => ({
      protocol: f.protocol,
      insideGlobal: f.global,
      insideLocal: f.inside,
      outside: { address: f.outside.address, port: f.outside.port ?? f.global.port },
    }));
  return [...statics, ...bindings, ...flows];
}

/** `clear ip nat translation *`: forgets every dynamic translation. Returns how many went. */
export function clearNat(ctx: IpContext): number {
  const { bindings, flows } = ctx.state.nat;
  const count = bindings.length + flows.length;
  ctx.state.nat = emptyNatTable();
  return count;
}
