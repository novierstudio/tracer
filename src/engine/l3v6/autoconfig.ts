import type { InterfaceId, PortId, RoutingTimers } from '@/model';
import {
  ALL_NODES,
  ALL_ROUTERS,
  ipv6MulticastMac,
  ipv6Prefix,
  UNSPECIFIED_IPV6,
  type Ipv6Cidr,
} from '@/model/ipv6';
import { ms } from '../core/time';
import {
  NDP_HOP_LIMIT,
  type Ipv6Packet,
  type PrefixInformation,
  type RouterAdvertisement,
  type RouterSolicitation,
} from '../pdu6';
import { isLan6, routesIpv6, sendOn, type Ipv6Interface, type LanInterface6 } from './interfaces';
import { learnNeighbor } from './nd';
import { interfacesOf6 } from './output';
import { timerKey, type Ipv6Context } from './state';

/**
 * How often a router advertises, in seconds. `ios` is IOS's 200 s, after up to three initial
 * advertisements 16 s apart (RFC 4861). `fast` keeps that shape at 10 s, 2 s apart.
 */
export const RA_TIMERS: Record<RoutingTimers, { interval: number; initial: number }> = {
  ios: { interval: 200, initial: 16 },
  fast: { interval: 10, initial: 2 },
};

const INITIAL_ADVERTISEMENTS = 3;

/** What IOS puts in its advertisements: a 30-minute router lifetime and IOS's prefix lifetimes. */
export const ROUTER_LIFETIME = 1800;
export const VALID_LIFETIME = 2_592_000;
export const PREFERRED_LIFETIME = 604_800;
const CUR_HOP_LIMIT = 64;
const MTU = 1500;

/** A host solicits up to three times, 4 s apart, until a router answers (RFC 4861). */
export const RTR_SOLICITATION_INTERVAL = ms(4000);
export const MAX_RTR_SOLICITATIONS = 3;

/** SLAAC forms addresses only from /64 prefixes, since EUI-64 fills the other 64 bits. */
const SLAAC_PREFIX_LENGTH = 64;

/** The prefixes a router interface advertises: those of its configured addresses, once each. */
function advertisedPrefixes(iface: Ipv6Interface): Ipv6Cidr[] {
  const prefixes = new Map<string, Ipv6Cidr>();
  for (const entry of iface.addresses) {
    if (entry.origin === 'autoconfig') continue;
    const prefix = ipv6Prefix(entry);
    prefixes.set(`${prefix.address}/${prefix.prefixLength}`, prefix);
  }
  return [...prefixes.values()];
}

/** The interfaces a router advertises on: up Ethernet ones. A serial link has no hosts to tell. */
const advertising = (ctx: Ipv6Context): LanInterface6[] =>
  routesIpv6(ctx.device)
    ? interfacesOf6(ctx)
        .filter(isLan6)
        .filter((iface) => iface.up)
    : [];

function advertise(ctx: Ipv6Context, iface: LanInterface6) {
  const prefixes = advertisedPrefixes(iface).map((prefix): PrefixInformation => ({
    prefix,
    onLink: true,
    autonomous: true,
    validLifetime: VALID_LIFETIME,
    preferredLifetime: PREFERRED_LIFETIME,
  }));
  const ra: RouterAdvertisement = {
    kind: 'icmpv6',
    type: 'router-advertisement',
    curHopLimit: CUR_HOP_LIMIT,
    managed: false,
    other: false,
    routerLifetime: ROUTER_LIFETIME,
    sourceMac: iface.medium.mac,
    mtu: MTU,
    prefixes,
  };
  const packet: Ipv6Packet = {
    kind: 'ipv6',
    src: iface.linkLocal,
    dst: ALL_NODES,
    hopLimit: NDP_HOP_LIMIT,
    payload: ra,
  };
  sendOn(ctx, iface, packet, ipv6MulticastMac(ALL_NODES));
}

/** What a router advertises everywhere, so a change can be told apart from the same again. */
const signatureOf = (interfaces: readonly LanInterface6[]) =>
  interfaces
    .map(
      (iface) =>
        `${iface.name}=${advertisedPrefixes(iface).map((p) => `${p.address}/${p.prefixLength}`)}`,
    )
    .join(';');

/**
 * Starts or stops a router's advertisements to match its config and links. A router that starts
 * advertising, or whose prefixes change, sends at once and then quickly a few times more.
 */
export function reconcileAdvertising(ctx: Ipv6Context) {
  const interfaces = advertising(ctx);
  if (interfaces.length === 0) {
    ctx.state.advertised = undefined;
    ctx.clearTimer(timerKey({ kind: 'ra' }));
    return;
  }
  const signature = signatureOf(interfaces);
  if (ctx.state.advertised?.signature === signature) return;
  ctx.state.advertised = { count: 0, signature };
  ctx.setTimer(timerKey({ kind: 'ra' }), ms(0));
}

/** The router's advertisement timer: advertise on every interface, then schedule the next. */
export function onAdvertiseTimer(ctx: Ipv6Context) {
  const interfaces = advertising(ctx);
  const advertised = ctx.state.advertised;
  if (interfaces.length === 0 || !advertised) return;
  for (const iface of interfaces) advertise(ctx, iface);
  advertised.count += 1;
  const { interval, initial } = RA_TIMERS[ctx.settings.routingTimers];
  const next = advertised.count < INITIAL_ADVERTISEMENTS ? initial : interval;
  ctx.setTimer(timerKey({ kind: 'ra' }), ms(next * 1000));
}

/** A router solicitation arrived: a router answers it with an advertisement on that link. */
export function onRouterSolicitation(
  ctx: Ipv6Context,
  iface: LanInterface6,
  port: PortId,
  packet: Ipv6Packet,
  rs: RouterSolicitation,
) {
  if (rs.sourceMac && packet.src !== UNSPECIFIED_IPV6) {
    learnNeighbor(ctx, iface, port, packet.src, rs.sourceMac, false);
  }
  if (routesIpv6(ctx.device)) advertise(ctx, iface);
}

/**
 * A router advertisement arrived. An interface that autoconfigures forms an address from each
 * autonomous /64 prefix, and a host takes the router as its default gateway.
 */
export function onRouterAdvertisement(
  ctx: Ipv6Context,
  iface: LanInterface6,
  port: PortId,
  packet: Ipv6Packet,
  ra: RouterAdvertisement,
) {
  learnNeighbor(ctx, iface, port, packet.src, ra.sourceMac, true);
  if (!iface.autoconfig) return;
  const kept = (ctx.state.slaac.get(iface.name) ?? []).filter(
    (held) => !ra.prefixes.some((info) => ipv6Prefix(info.prefix).address === held.prefix),
  );
  for (const info of ra.prefixes) {
    if (!info.autonomous || info.prefix.prefixLength !== SLAAC_PREFIX_LENGTH) continue;
    if (info.validLifetime === 0) continue;
    kept.push({ prefix: ipv6Prefix(info.prefix).address, router: packet.src });
  }
  if (kept.length > 0) ctx.state.slaac.set(iface.name, kept);
  else ctx.state.slaac.delete(iface.name);
  if (ctx.device.kind === 'pc' || ctx.device.kind === 'server') {
    const current = ctx.state.defaultRouter;
    if (ra.routerLifetime > 0 && (!current || current.address === packet.src)) {
      ctx.state.defaultRouter = { address: packet.src, interface: iface.name };
    } else if (ra.routerLifetime === 0 && current?.address === packet.src) {
      ctx.state.defaultRouter = undefined;
    }
  }
  ctx.state.solicited.delete(iface.name);
  ctx.clearTimer(timerKey({ kind: 'rs', interface: iface.name }));
}

/** Starts soliciting on each up interface that autoconfigures and has heard no router yet. */
export function startSoliciting(ctx: Ipv6Context) {
  for (const iface of interfacesOf6(ctx)) {
    if (!iface.up || !iface.autoconfig || !isLan6(iface)) continue;
    if (ctx.state.slaac.has(iface.name) || ctx.state.solicited.has(iface.name)) continue;
    ctx.state.solicited.set(iface.name, 0);
    ctx.setTimer(timerKey({ kind: 'rs', interface: iface.name }), ms(0));
  }
}

/** An interface's solicitation timer: solicit again, up to MAX_RTR_SOLICITATIONS times. */
export function onSolicitTimer(ctx: Ipv6Context, name: InterfaceId) {
  const iface = interfacesOf6(ctx).find((candidate) => candidate.name === name);
  const sent = ctx.state.solicited.get(name);
  if (!iface || !isLan6(iface) || !iface.up || !iface.autoconfig || sent === undefined) return;
  if (sent >= MAX_RTR_SOLICITATIONS || ctx.state.slaac.has(iface.name)) return;
  const rs: RouterSolicitation = {
    kind: 'icmpv6',
    type: 'router-solicitation',
    sourceMac: iface.medium.mac,
  };
  const packet: Ipv6Packet = {
    kind: 'ipv6',
    src: iface.linkLocal,
    dst: ALL_ROUTERS,
    hopLimit: NDP_HOP_LIMIT,
    payload: rs,
  };
  sendOn(ctx, iface, packet, ipv6MulticastMac(ALL_ROUTERS));
  ctx.state.solicited.set(iface.name, sent + 1);
  ctx.setTimer(timerKey({ kind: 'rs', interface: iface.name }), RTR_SOLICITATION_INTERVAL);
}

/**
 * Drops what SLAAC learned on interfaces that no longer autoconfigure or went down, so a host
 * that comes back up asks again. A host whose gateway's interface went with it loses the gateway.
 */
export function forgetAutoconfig(ctx: Ipv6Context) {
  const live = new Set(
    interfacesOf6(ctx)
      .filter((iface) => iface.up && iface.autoconfig)
      .map((iface) => iface.name),
  );
  for (const name of [...ctx.state.slaac.keys()]) if (!live.has(name)) ctx.state.slaac.delete(name);
  for (const name of [...ctx.state.solicited.keys()]) {
    if (live.has(name)) continue;
    ctx.state.solicited.delete(name);
    ctx.clearTimer(timerKey({ kind: 'rs', interface: name }));
  }
  const router = ctx.state.defaultRouter;
  if (router && !live.has(router.interface)) ctx.state.defaultRouter = undefined;
}
