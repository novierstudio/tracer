import type {
  DhcpPool,
  DhcpServerConfig,
  InterfaceId,
  Ipv4Address,
  Ipv4Cidr,
  MacAddress,
} from '@/model';
import { DEFAULT_DHCP_LEASE } from '@/model/defaults';
import { homeRouterIos } from '@/model/wireless';
import { after, ms, type SimTime } from '../core/time';
import {
  LIMITED_BROADCAST,
  UDP_PORT,
  UNSPECIFIED_ADDRESS,
  type DhcpGrant,
  type DhcpMessage,
  type Ipv4Packet,
} from '../pdu';
import { interfacesOf, type IpContext } from './context';
import { isLan, ownsAddress, routesPackets, type IpInterface } from './interfaces';
import { compareAddresses, inPrefix, ipv4ToUint32, uint32ToIpv4 } from './ipv4';
import { broadcastOn, originate } from './output';
import { udp } from './udp';

/** An address the server has promised a client: offered and held for it, or leased. */
export type DhcpBinding = {
  readonly address: Ipv4Address;
  readonly pool: string;
  readonly state: 'offered' | 'bound';
  /** When the offer or the lease lapses. Absent for an infinite lease. */
  readonly expiresAt?: SimTime;
};

/** A lease the router has granted, as `show ip dhcp binding` lists it. */
export type DhcpBindingEntry = {
  readonly address: Ipv4Address;
  readonly mac: MacAddress;
  readonly pool: string;
  /** Absent for an infinite lease. */
  readonly expiresAt?: SimTime;
};

/** How long an offered address waits for the client to ask for it. */
const OFFER_HOLD = ms(60_000);

type Pool = DhcpPool & { readonly network: Ipv4Cidr };

const isLive = (binding: DhcpBinding, now: SimTime) =>
  binding.expiresAt === undefined || binding.expiresAt > now;

/** The router's leases in force, by address. */
export function dhcpBindings(ctx: IpContext): DhcpBindingEntry[] {
  const entries: DhcpBindingEntry[] = [];
  for (const [mac, binding] of ctx.state.bindings) {
    if (binding.state !== 'bound' || !isLive(binding, ctx.now)) continue;
    const { address, pool, expiresAt } = binding;
    entries.push({ address, mac, pool, ...(expiresAt !== undefined && { expiresAt }) });
  }
  return entries.sort((a, b) => compareAddresses(a.address, b.address));
}

/** The pool for clients on the network of `address`: the narrowest one that holds it. */
function poolFor(config: DhcpServerConfig, address: Ipv4Address): [string, Pool] | undefined {
  let best: [string, Pool] | undefined;
  for (const [name, pool] of Object.entries(config.pools)) {
    const { network } = pool;
    if (!network || !inPrefix(network, address)) continue;
    if (!best || network.prefixLength > best[1].network.prefixLength) {
      best = [name, { ...pool, network }];
    }
  }
  return best;
}

/** Every address configured on the router, which no pool may lend whether or not it is up. */
function ownAddresses(ctx: IpContext): Set<number> {
  const { device } = ctx;
  if (device.kind === 'wirelessRouter') return new Set([ipv4ToUint32(device.config.lan.address)]);
  if (device.kind !== 'router') return new Set();
  const { interfaces, subinterfaces, virtualInterfaces } = device.config;
  const configured = [
    ...Object.values(interfaces),
    ...Object.values(subinterfaces),
    ...Object.values(virtualInterfaces),
  ];
  return new Set(
    configured.flatMap((iface) => (iface.ipv4 ? [ipv4ToUint32(iface.ipv4.address)] : [])),
  );
}

/**
 * The address to lend `mac` from `pool`: the one it already holds, else `wanted` when free, else
 * the lowest free one. Excluded ranges, the router's own addresses and other clients' live
 * offers and leases are not free, nor are the network and broadcast addresses. Undefined when
 * the pool is exhausted.
 */
function allocate(
  ctx: IpContext,
  config: DhcpServerConfig,
  [name, pool]: [string, Pool],
  mac: MacAddress,
  wanted?: Ipv4Address,
): Ipv4Address | undefined {
  const held = ctx.state.bindings.get(mac);
  const taken = ownAddresses(ctx);
  for (const [other, binding] of ctx.state.bindings) {
    if (other !== mac && isLive(binding, ctx.now)) taken.add(ipv4ToUint32(binding.address));
  }
  const excluded = config.excluded.map(({ first, last }) => [
    ipv4ToUint32(first),
    ipv4ToUint32(last),
  ]);
  const network = ipv4ToUint32(pool.network.address);
  const size = 2 ** (32 - pool.network.prefixLength);
  const free = (n: number) =>
    n > network &&
    n < network + size - 1 &&
    !taken.has(n) &&
    !excluded.some(([first, last]) => n >= first! && n <= last!);

  const candidates = [
    held && held.pool === name && isLive(held, ctx.now) ? held.address : undefined,
    wanted,
  ];
  for (const candidate of candidates) {
    if (candidate && free(ipv4ToUint32(candidate))) return candidate;
  }
  for (let n = network + 1; n < network + size - 1; n++) {
    // Skip an excluded range in one step, so a mostly excluded pool is quick to search.
    const range = excluded.find(([first, last]) => n >= first! && n <= last!);
    if (range) n = range[1]!;
    else if (!taken.has(n)) return uint32ToIpv4(n);
  }
  return undefined;
}

function grant(pool: Pool, serverId: Ipv4Address): DhcpGrant {
  const lease = pool.lease ?? DEFAULT_DHCP_LEASE;
  return {
    serverId,
    leaseTime: lease === 'infinite' ? 'infinite' : lease * 60,
    subnetMask: pool.network.prefixLength,
    routers: pool.defaultRouters ?? [],
    dnsServers: pool.dnsServers ?? [],
  };
}

const isSet = (address: Ipv4Address) => address !== UNSPECIFIED_ADDRESS;

/**
 * Sends a server's reply as RFC 2131 has it: to the relay agent that passed the request on, else
 * to the client's own address when it has one, else broadcast on the network it asked from.
 */
function reply(
  ctx: IpContext,
  request: DhcpMessage,
  response: DhcpMessage,
  arrival: IpInterface | undefined,
) {
  if (isSet(request.giaddr)) {
    originate(ctx, request.giaddr, udp(UDP_PORT.dhcpServer, UDP_PORT.dhcpServer, response));
  } else if (isSet(request.ciaddr) && response.type !== 'nak') {
    originate(ctx, request.ciaddr, udp(UDP_PORT.dhcpServer, UDP_PORT.dhcpClient, response));
  } else if (arrival && isLan(arrival)) {
    broadcastOn(ctx, arrival, udp(UDP_PORT.dhcpServer, UDP_PORT.dhcpClient, response));
  }
}

/** The reply's fixed fields: the request's transaction and client, and its relay agent. */
const replyHeader = (request: DhcpMessage, yiaddr: Ipv4Address = UNSPECIFIED_ADDRESS) =>
  ({
    kind: 'dhcp',
    xid: request.xid,
    hops: 0,
    broadcast: request.broadcast,
    ciaddr: request.ciaddr,
    yiaddr,
    giaddr: request.giaddr,
    chaddr: request.chaddr,
  }) as const;

/**
 * A client's message reached the router's DHCP server, on `arrival` or relayed from another
 * network. The client's network is the relay agent's, else the address it already has, else the
 * one it asked on, and the pool for that network answers. With no such pool the server stays
 * silent, as IOS does.
 */
function serve(ctx: IpContext, message: DhcpMessage, arrival: IpInterface | undefined) {
  const { device } = ctx;
  const config =
    device.kind === 'router'
      ? device.config.dhcp
      : device.kind === 'wirelessRouter'
        ? homeRouterIos(device.config).dhcp
        : undefined;
  if (!config) return;
  const network = isSet(message.giaddr)
    ? message.giaddr
    : isSet(message.ciaddr)
      ? message.ciaddr
      : arrival?.cidr.address;
  const found = network && poolFor(config, network);
  if (!found) return;
  const [name, pool] = found;
  // A request relayed to one of the router's own addresses loops back with no interface.
  const serverId = arrival?.cidr.address ?? message.giaddr;
  const { bindings } = ctx.state;
  const { chaddr: mac } = message;
  const held = bindings.get(mac);
  const live = held && isLive(held, ctx.now) ? held : undefined;

  const ack = (address: Ipv4Address) => {
    const lease = pool.lease ?? DEFAULT_DHCP_LEASE;
    bindings.set(mac, {
      address,
      pool: name,
      state: 'bound',
      ...(lease !== 'infinite' && { expiresAt: after(ctx.now, ms(lease * 60_000)) }),
    });
    reply(
      ctx,
      message,
      { ...replyHeader(message, address), type: 'ack', ...grant(pool, serverId) },
      arrival,
    );
  };
  const nak = () =>
    reply(ctx, message, { ...replyHeader(message), type: 'nak', serverId }, arrival);

  switch (message.type) {
    case 'discover': {
      const address = allocate(ctx, config, found, mac, message.requestedIp);
      if (!address) {
        ctx.note(`DHCP pool ${name} has no free address for ${mac}`);
        return;
      }
      // A client that already holds the address keeps its lease while it asks again.
      if (live?.state !== 'bound' || live.address !== address) {
        bindings.set(mac, {
          address,
          pool: name,
          state: 'offered',
          expiresAt: after(ctx.now, OFFER_HOLD),
        });
      }
      reply(
        ctx,
        message,
        { ...replyHeader(message, address), type: 'offer', ...grant(pool, serverId) },
        arrival,
      );
      return;
    }
    case 'request': {
      if (message.serverId !== undefined) {
        // Answering an offer. One from another server means this server's offer lost.
        if (!ownsAddress(interfacesOf(ctx), message.serverId)) {
          if (live?.state === 'offered') bindings.delete(mac);
          return;
        }
        if (live && live.address === message.requestedIp) ack(live.address);
        else nak();
        return;
      }
      // Renewing, rebinding, or asking again for an address it had.
      const address = message.requestedIp ?? message.ciaddr;
      if (!isSet(address) || !inPrefix(pool.network, address)) {
        nak();
        return;
      }
      if (live?.address === address || allocate(ctx, config, found, mac, address) === address) {
        ack(address);
      } else nak();
      return;
    }
    case 'release':
      if (held?.address === message.ciaddr) bindings.delete(mac);
      return;
    case 'offer':
    case 'ack':
    case 'nak':
      return;
  }
}

/**
 * Where an interface relays DHCP broadcasts to, from its `ip helper-address` lines: a router's
 * port or subinterface, or a routing switch's routed port or VLAN interface.
 */
function helpersOf(ctx: IpContext, name: InterfaceId): readonly Ipv4Address[] {
  const { device } = ctx;
  if (!routesPackets(device)) return [];
  const key = name as never;
  switch (device.kind) {
    case 'router': {
      const { interfaces, subinterfaces } = device.config;
      return (name in interfaces ? interfaces[key] : subinterfaces[key])?.helperAddresses ?? [];
    }
    case 'switch': {
      const { interfaces, virtualInterfaces } = device.config;
      return (name in interfaces ? interfaces[key] : virtualInterfaces[key])?.helperAddresses ?? [];
    }
    default:
      return [];
  }
}

/**
 * Relays a client's broadcast to each helper address, as unicast with the interface it came in
 * on as the relay agent, which tells the server the client's network.
 */
function relay(
  ctx: IpContext,
  message: DhcpMessage,
  arrival: IpInterface,
  helpers: readonly Ipv4Address[],
) {
  const relayed = {
    ...message,
    giaddr: isSet(message.giaddr) ? message.giaddr : arrival.cidr.address,
    hops: message.hops + 1,
  };
  for (const helper of helpers) {
    originate(ctx, helper, udp(UDP_PORT.dhcpServer, UDP_PORT.dhcpServer, relayed));
  }
}

/** Passes a server's reply back onto the client's network, which its relay agent names. */
function relayBack(ctx: IpContext, message: DhcpMessage) {
  const iface = interfacesOf(ctx).find(
    (candidate) => isLan(candidate) && candidate.cidr.address === message.giaddr,
  );
  if (!iface || !isLan(iface)) return;
  if (isSet(message.ciaddr) && !message.broadcast && message.type !== 'nak') {
    originate(ctx, message.ciaddr, udp(UDP_PORT.dhcpServer, UDP_PORT.dhcpClient, message));
  } else {
    broadcastOn(ctx, iface, udp(UDP_PORT.dhcpServer, UDP_PORT.dhcpClient, message));
  }
}

const FROM_CLIENT: Record<DhcpMessage['type'], boolean> = {
  discover: true,
  request: true,
  release: true,
  offer: false,
  ack: false,
  nak: false,
};

/**
 * A datagram for port 67 reached a router. A client's broadcast on an interface with helper
 * addresses is relayed; any other client message goes to the router's own server. A server's
 * reply is one this router relayed, on its way back to the client.
 */
export function onDhcpServerPort(
  ctx: IpContext,
  packet: Ipv4Packet,
  message: DhcpMessage,
  arrival: IpInterface | undefined,
) {
  if (!routesPackets(ctx.device)) return;
  if (!FROM_CLIENT[message.type]) {
    relayBack(ctx, message);
    return;
  }
  const helpers = arrival ? helpersOf(ctx, arrival.name) : [];
  if (arrival && packet.dst === LIMITED_BROADCAST && helpers.length > 0) {
    relay(ctx, message, arrival, helpers);
  } else {
    serve(ctx, message, arrival);
  }
}
