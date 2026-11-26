import type { Ipv4Address, Ipv4Cidr, MacAddress, PortId, PrefixLength } from '@/model';
import { after, ms, type SimTime } from '../core/time';
import type { DeviceContext } from '../module';
import {
  BROADCAST_MAC,
  LIMITED_BROADCAST,
  UDP_PORT,
  UNSPECIFIED_ADDRESS,
  type DhcpMessage,
  type EthernetFrame,
} from '../pdu';
import { timerKey, type IpContext } from './context';
import { hostPort, isHost } from './hostAddress';
import { INITIAL_TTL, originate } from './output';
import { udp } from './udp';

/** What a host holds from a DHCP server. */
export type Lease = {
  readonly address: Ipv4Cidr;
  readonly gateway?: Ipv4Address;
  readonly dns: readonly Ipv4Address[];
  /** The server that granted it, which renewals and the release go to. */
  readonly server: Ipv4Address;
  /**
   * The MAC the Ack came from: the server's, or the relay agent's when it crossed one. A release
   * goes straight to it, since the address is gone the moment the release leaves.
   */
  readonly via: MacAddress;
  readonly obtainedAt: SimTime;
  /** Absent for an infinite lease. */
  readonly expiresAt?: SimTime;
};

type Offer = Extract<DhcpMessage, { type: 'offer' }>;
type Ack = Extract<DhcpMessage, { type: 'ack' }>;

/**
 * Where a host's DHCP client is, after RFC 2131's states. `xid` is the transaction its replies
 * must carry. While a host that gave itself a link-local address asks again, it keeps that
 * address as `fallback`.
 */
export type DhcpClient =
  /** Not running: the host is static, its link is down, or it has not booted yet. */
  | { readonly kind: 'stopped' }
  /** `ipconfig /release` gave the lease back, and the client waits to be asked again. */
  | { readonly kind: 'released' }
  /** Discover number `tries` went out, and it waits for an Offer. */
  | {
      readonly kind: 'selecting';
      readonly xid: number;
      readonly tries: number;
      readonly fallback?: Ipv4Cidr;
    }
  /** It asked for the address it was offered and waits for the Ack. */
  | {
      readonly kind: 'requesting';
      readonly xid: number;
      readonly tries: number;
      readonly offer: Offer;
      readonly fallback?: Ipv4Cidr;
    }
  | { readonly kind: 'bound'; readonly lease: Lease }
  /** It asked the lease's server to extend it, and waits for the Ack until `until`. */
  | {
      readonly kind: 'renewing';
      readonly xid: number;
      readonly lease: Lease;
      readonly until: SimTime;
    }
  /** The server never answered: it asks any server, until the lease runs out. */
  | { readonly kind: 'rebinding'; readonly xid: number; readonly lease: Lease }
  /** No server answered at all, so it gave itself a link-local address and tries again later. */
  | { readonly kind: 'autoconfigured'; readonly address: Ipv4Cidr };

export const DHCP_STOPPED: DhcpClient = { kind: 'stopped' };

/** What `ipconfig /renew` waits for: a lease, or word that none came. */
export type DhcpOutcome =
  { readonly kind: 'bound'; readonly lease: Lease } | { readonly kind: 'failed' };

export type DhcpListener = (outcome: DhcpOutcome) => void;

/**
 * The waits between Discovers, doubling as RFC 2131 has them. Five Discovers go out over a
 * minute, so a host behind a switch port that spanning tree holds for 30 s still gets through.
 */
const DISCOVER_WAITS = [4000, 8000, 16000, 32000].map(ms);

/** How long the last Discover waits for an Offer, and a Request for its Ack. */
const REPLY_WAIT = ms(4000);

/** How long `ipconfig /renew` waits on the lease's server before saying it failed. */
const RENEW_WAIT = ms(4000);

/** Windows asks again this often while it has a link-local address. */
const AUTOCONFIG_RETRY = ms(5 * 60_000);

/** A lease renews with its server halfway through, and with any server at seven eighths. */
const T1 = 0.5;
const T2 = 0.875;

const TIMER = timerKey({ kind: 'dhcp' });

const LINK_LOCAL_PREFIX = 16 as PrefixLength;

/** A powered host whose config asks for DHCP starts asking once it boots. */
export function bootDhcp(ctx: DeviceContext) {
  const { device } = ctx;
  if (isHost(device) && device.config.ipv4.mode === 'dhcp') ctx.setTimer(TIMER, ms(0));
}

/** The port the client runs on, while the host wants DHCP and that port's link is up. */
function clientPort(ctx: IpContext) {
  const { device } = ctx;
  if (!isHost(device) || device.config.ipv4.mode !== 'dhcp') return undefined;
  const port = hostPort(device);
  return port && ctx.portUp(port.id) ? port : undefined;
}

/** Tells whoever waits on the client how it went. */
function settle(ctx: IpContext, outcome: DhcpOutcome) {
  for (const listener of ctx.state.dhcpWaiters.splice(0)) listener(outcome);
}

const newXid = (ctx: IpContext) => Math.floor(ctx.random() * 0x1_0000_0000);

/**
 * The fixed fields of a message from this client. With no address it asks for broadcast
 * replies, since it cannot take unicast yet.
 */
function header(mac: MacAddress, xid: number, ciaddr: Ipv4Address = UNSPECIFIED_ADDRESS) {
  return {
    kind: 'dhcp',
    xid,
    hops: 0,
    broadcast: ciaddr === UNSPECIFIED_ADDRESS,
    ciaddr,
    yiaddr: UNSPECIFIED_ADDRESS,
    giaddr: UNSPECIFIED_ADDRESS,
    chaddr: mac,
  } as const;
}

/**
 * Sends a message to the server port of `dst`, from `src`, in a frame for `dstMac`: by default a
 * broadcast from no address. The client builds the frame itself, since IP cannot send from a host
 * without an address.
 */
function send(
  ctx: IpContext,
  port: { id: PortId; mac: MacAddress },
  message: DhcpMessage,
  { src = UNSPECIFIED_ADDRESS, dst = LIMITED_BROADCAST, dstMac = BROADCAST_MAC } = {},
) {
  const frame: EthernetFrame = {
    kind: 'ethernet',
    dst: dstMac,
    src: port.mac,
    payload: {
      kind: 'ipv4',
      src,
      dst,
      ttl: INITIAL_TTL[ctx.device.kind],
      id: ctx.state.nextPacketId++,
      payload: udp(UDP_PORT.dhcpClient, UDP_PORT.dhcpServer, message),
    },
  };
  ctx.send(port.id, frame);
}

/** When a lease is `fraction` of the way through. Undefined for an infinite lease. */
function pointIn(lease: Lease, fraction: number): SimTime | undefined {
  if (lease.expiresAt === undefined) return undefined;
  return (lease.obtainedAt + (lease.expiresAt - lease.obtainedAt) * fraction) as SimTime;
}

function waitUntil(ctx: IpContext, time: SimTime | undefined) {
  if (time === undefined) ctx.clearTimer(TIMER);
  else ctx.setTimer(TIMER, ms(Math.max(0, time - ctx.now)));
}

/** Sends Discover number `tries`, and waits for an Offer. */
function select(ctx: IpContext, fallback: Ipv4Cidr | undefined, tries = 1, xid = newXid(ctx)) {
  const port = clientPort(ctx);
  if (!port) return;
  ctx.state.dhcp = { kind: 'selecting', xid, tries, ...(fallback && { fallback }) };
  send(ctx, port, { ...header(port.mac, xid), type: 'discover' });
  ctx.setTimer(TIMER, DISCOVER_WAITS[tries - 1] ?? REPLY_WAIT);
}

/** Tries again after a Discover or Request went unanswered, or gives up after the last. */
function retry(ctx: IpContext, tries: number, fallback: Ipv4Cidr | undefined, xid?: number) {
  if (tries <= DISCOVER_WAITS.length) {
    select(ctx, fallback, tries + 1, xid);
    return;
  }
  // Windows avoids 169.254.0.x and 169.254.255.x, which RFC 3927 reserves.
  const address = fallback ?? {
    address:
      `169.254.${1 + Math.floor(ctx.random() * 254)}.${Math.floor(ctx.random() * 256)}` as Ipv4Address,
    prefixLength: LINK_LOCAL_PREFIX,
  };
  if (!fallback) ctx.note(`No DHCP server answered: using link-local address ${address.address}`);
  ctx.state.dhcp = { kind: 'autoconfigured', address };
  ctx.setTimer(TIMER, AUTOCONFIG_RETRY);
  settle(ctx, { kind: 'failed' });
}

function request(ctx: IpContext, offer: Offer, tries: number, fallback: Ipv4Cidr | undefined) {
  const port = clientPort(ctx);
  if (!port) return;
  ctx.state.dhcp = {
    kind: 'requesting',
    xid: offer.xid,
    tries,
    offer,
    ...(fallback && { fallback }),
  };
  send(ctx, port, {
    ...header(port.mac, offer.xid),
    type: 'request',
    requestedIp: offer.yiaddr,
    serverId: offer.serverId,
  });
  ctx.setTimer(TIMER, REPLY_WAIT);
}

function bind(ctx: IpContext, ack: Ack, via: MacAddress) {
  const { yiaddr, subnetMask, routers, dnsServers, serverId, leaseTime } = ack;
  const lease: Lease = {
    address: { address: yiaddr, prefixLength: subnetMask },
    ...(routers[0] && { gateway: routers[0] }),
    dns: dnsServers,
    server: serverId,
    via,
    obtainedAt: ctx.now,
    ...(leaseTime !== 'infinite' && { expiresAt: after(ctx.now, ms(leaseTime * 1000)) }),
  };
  ctx.state.dhcp = { kind: 'bound', lease };
  waitUntil(ctx, pointIn(lease, T1));
  settle(ctx, { kind: 'bound', lease });
}

/** Asks the lease's server, from the leased address, to extend it, and waits until `until`. */
function renew(ctx: IpContext, lease: Lease, until: SimTime) {
  const port = clientPort(ctx);
  if (!port) return;
  const xid = newXid(ctx);
  ctx.state.dhcp = { kind: 'renewing', xid, lease, until };
  const message = { ...header(port.mac, xid, lease.address.address), type: 'request' } as const;
  // The host has its address, so IP routes the request and resolves its next hop.
  originate(ctx, lease.server, udp(UDP_PORT.dhcpClient, UDP_PORT.dhcpServer, message));
  waitUntil(ctx, until);
}

/** Asks any server on the network to extend the lease, until it runs out. */
function rebind(ctx: IpContext, lease: Lease) {
  const port = clientPort(ctx);
  if (!port) return;
  const xid = newXid(ctx);
  ctx.state.dhcp = { kind: 'rebinding', xid, lease };
  const src = lease.address.address;
  send(ctx, port, { ...header(port.mac, xid, src), type: 'request' }, { src });
  waitUntil(ctx, lease.expiresAt);
}

/** The client's one timer went off: what it means depends on where the client is. */
export function onDhcpTimer(ctx: IpContext) {
  const client = ctx.state.dhcp;
  switch (client.kind) {
    case 'stopped':
      // The host booted.
      reconcileDhcp(ctx);
      return;
    case 'released':
      return;
    case 'selecting':
      retry(ctx, client.tries, client.fallback, client.xid);
      return;
    case 'requesting':
      // No Ack: start over with a new transaction, counting this as a try.
      retry(ctx, client.tries, client.fallback);
      return;
    case 'bound':
      renew(ctx, client.lease, pointIn(client.lease, T2) ?? ctx.now);
      return;
    case 'renewing': {
      // Whoever waits on a renewal hears it failed. The lease still holds until it runs out.
      settle(ctx, { kind: 'failed' });
      const { lease } = client;
      const t1 = pointIn(lease, T1);
      const t2 = pointIn(lease, T2);
      if (t2 !== undefined && ctx.now >= t2) rebind(ctx, lease);
      else if (t1 !== undefined && t2 !== undefined && ctx.now >= t1) renew(ctx, lease, t2);
      else {
        ctx.state.dhcp = { kind: 'bound', lease };
        waitUntil(ctx, t1);
      }
      return;
    }
    case 'rebinding':
      ctx.note(`The DHCP lease on ${client.lease.address.address} ran out`);
      select(ctx, undefined);
      return;
    case 'autoconfigured':
      select(ctx, client.address);
      return;
  }
}

/**
 * Brings the client in line with the host: it runs while the host's config asks for DHCP and its
 * link is up, and stops, forgetting any lease, otherwise. Safe to call on any change.
 */
export function reconcileDhcp(ctx: IpContext) {
  const client = ctx.state.dhcp;
  if (!clientPort(ctx)) {
    if (client.kind === 'stopped') return;
    ctx.state.dhcp = DHCP_STOPPED;
    ctx.clearTimer(TIMER);
    settle(ctx, { kind: 'failed' });
    return;
  }
  if (client.kind === 'stopped') select(ctx, undefined);
}

/** The DHCP message in a frame that a client should read: a datagram for port 68. */
export function dhcpReplyIn(frame: EthernetFrame): DhcpMessage | undefined {
  const packet = frame.payload;
  if (packet.kind !== 'ipv4') return undefined;
  const datagram = packet.payload;
  if (datagram.kind !== 'udp' || datagram.dstPort !== UDP_PORT.dhcpClient) return undefined;
  return datagram.payload.kind === 'dhcp' ? datagram.payload : undefined;
}

/**
 * Hands the client a DHCP reply that reached a DHCP host's port, for its MAC or broadcast. Like a
 * real client, it reads them beside IP rather than through it, since it may have no address yet.
 * Returns whether the frame was one, which IP must then not see. A reply for another client's
 * MAC is taken and ignored.
 */
export function takeDhcpReply(ctx: IpContext, port: PortId, frame: EthernetFrame): boolean {
  const own = clientPort(ctx);
  if (!own || own.id !== port || frame.tag) return false;
  if (frame.dst !== own.mac && frame.dst !== BROADCAST_MAC) return false;
  const message = dhcpReplyIn(frame);
  if (!message) return false;
  const client = ctx.state.dhcp;
  if (message.chaddr !== own.mac || !('xid' in client) || message.xid !== client.xid) return true;
  switch (message.type) {
    case 'offer':
      if (client.kind === 'selecting') request(ctx, message, client.tries, client.fallback);
      return true;
    case 'ack':
      if (client.kind !== 'selecting') bind(ctx, message, frame.src);
      return true;
    case 'nak':
      if (client.kind === 'selecting') return true;
      ctx.note(`DHCP server ${message.serverId} refused the request`);
      select(ctx, client.kind === 'requesting' ? client.fallback : undefined);
      return true;
    default:
      return true;
  }
}

/**
 * `ipconfig /renew`: a host with a lease asks its server to extend it; one without starts asking
 * for one. `listener` hears the lease, or that none came.
 */
export function renewDhcp(ctx: IpContext, listener: DhcpListener) {
  if (!clientPort(ctx)) {
    listener({ kind: 'failed' });
    return;
  }
  ctx.state.dhcpWaiters.push(listener);
  const client = ctx.state.dhcp;
  switch (client.kind) {
    case 'bound':
    case 'renewing':
    case 'rebinding': {
      const t2 = pointIn(client.lease, T2);
      const wait = after(ctx.now, RENEW_WAIT);
      renew(ctx, client.lease, t2 !== undefined && t2 > ctx.now && t2 < wait ? t2 : wait);
      return;
    }
    case 'selecting':
    case 'requesting':
      return;
    case 'autoconfigured':
      select(ctx, client.address);
      return;
    case 'stopped':
    case 'released':
      select(ctx, undefined);
      return;
  }
}

/** `ipconfig /release`: gives a lease back to its server, and asks for nothing until told to. */
export function releaseDhcp(ctx: IpContext) {
  const client = ctx.state.dhcp;
  const port = clientPort(ctx);
  if (!port || client.kind === 'stopped') return;
  if (client.kind === 'bound' || client.kind === 'renewing' || client.kind === 'rebinding') {
    const { lease } = client;
    const src = lease.address.address;
    send(
      ctx,
      port,
      { ...header(port.mac, newXid(ctx), src), type: 'release', serverId: lease.server },
      { src, dst: lease.server, dstMac: lease.via },
    );
  }
  ctx.state.dhcp = { kind: 'released' };
  ctx.clearTimer(TIMER);
  settle(ctx, { kind: 'failed' });
}

/** The host is going away: whoever waits on its client hears that nothing came. */
export function abandonDhcp(ctx: IpContext) {
  settle(ctx, { kind: 'failed' });
}
