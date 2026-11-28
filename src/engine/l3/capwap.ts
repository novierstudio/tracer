import type { Ipv4Address, WirelessProfile } from '@/model';
import { APP_PORT, type CapwapMessage } from '../apps';
import { ms } from '../core/time';
import type { Ipv4Packet, UdpDatagram } from '../pdu';
import { hostAddressingOf, interfacesOf, timerKey, type IpContext } from './context';
import { addressOf } from './hostAddress';
import { isLan } from './interfaces';
import { broadcastOn, originate } from './output';
import { udp } from './udp';

/**
 * CAPWAP between lightweight APs and wireless LAN controllers, as Packet Tracer runs it. An AP
 * with a DHCP lease asks for a controller: the ones its lease's option 43 names, else every
 * controller on its subnet by broadcast. It joins the first that answers, broadcasts the WLANs
 * that controller pushes to it, and sends an Echo Request every 30 seconds; three unanswered in a
 * row and it starts over. Client traffic is bridged at the AP, as FlexConnect local switching
 * does: only the control channel goes to the controller.
 */

/** A lightweight AP's CAPWAP state machine. */
export type CapwapAp =
  | { readonly phase: 'idle' }
  | { readonly phase: 'discovering'; readonly tries: number }
  | { readonly phase: 'joining'; readonly controller: Ipv4Address; readonly name: string }
  | {
      readonly phase: 'joined';
      readonly controller: Ipv4Address;
      readonly name: string;
      readonly wlans: readonly WirelessProfile[];
      readonly missed: number;
    };

/** An AP a controller has joined, by its address. */
export type JoinedAp = {
  readonly name: string;
  readonly model: string;
  readonly joinedAt: number;
  lastSeen: number;
};

/** A controller's side: its APs, and the WLANs it last pushed to them, as JSON. */
export type CapwapController = { readonly aps: Map<Ipv4Address, JoinedAp>; pushed: string };

export const CAPWAP_IDLE: CapwapAp = { phase: 'idle' };

export const emptyController = (): CapwapController => ({ aps: new Map(), pushed: '[]' });

const RETRY = ms(3_000);
const ECHO_INTERVAL = ms(30_000);
const MAX_MISSED = 3;
/** A controller forgets an AP it has not heard from for this long. */
const AP_TIMEOUT = 100_000;

const key = timerKey({ kind: 'app', name: 'capwap' });

const send = (ctx: IpContext, to: Ipv4Address, message: CapwapMessage) =>
  originate(ctx, to, udp(APP_PORT.capwap, APP_PORT.capwap, message));

/** The networks the AP broadcasts now: its controller's WLANs once joined, else none. */
export const apBroadcasts = (ap: CapwapAp): readonly WirelessProfile[] =>
  ap.phase === 'joined' ? ap.wlans : [];

/** Moves the AP to `next`, and lets the engine re-derive associations if its WLANs changed. */
function become(ctx: IpContext, next: CapwapAp) {
  const before = JSON.stringify(apBroadcasts(ctx.state.apps.capwap));
  ctx.state.apps.capwap = next;
  if (JSON.stringify(apBroadcasts(next)) !== before) ctx.reassociate();
}

/** A lightweight AP starts looking for a controller as soon as it boots. */
export function bootCapwap(ctx: Pick<IpContext, 'device' | 'setTimer'>) {
  if (ctx.device.kind === 'lightweightAp') ctx.setTimer(key, RETRY);
}

/** The AP's own address, once its lease has come. */
const ownAddress = (ctx: IpContext) => {
  const host = hostAddressingOf(ctx);
  return host?.kind === 'leased' ? host : undefined;
};

/** Sends a Discovery Request to each controller option 43 named, else by broadcast. */
function discover(ctx: IpContext) {
  const lease = ownAddress(ctx);
  if (!lease) return;
  const request: CapwapMessage = { kind: 'capwap', type: 'discovery-request' };
  if (lease.controllers?.length) {
    for (const controller of lease.controllers) send(ctx, controller, request);
    return;
  }
  const lan = interfacesOf(ctx).find(isLan);
  if (lan) broadcastOn(ctx, lan, udp(APP_PORT.capwap, APP_PORT.capwap, request));
}

/** The AP's one timer: a retry while it looks for or joins a controller, then the echo. */
export function onCapwapTimer(ctx: IpContext) {
  if (ctx.device.kind !== 'lightweightAp') return;
  ctx.setTimer(key, RETRY);
  const ap = ctx.state.apps.capwap;
  if (!ownAddress(ctx)) {
    if (ap.phase !== 'idle') ctx.note('Lost its address: leaves its controller');
    become(ctx, CAPWAP_IDLE);
    return;
  }
  switch (ap.phase) {
    case 'idle':
    case 'joining':
      become(ctx, { phase: 'discovering', tries: 1 });
      discover(ctx);
      return;
    case 'discovering':
      become(ctx, { phase: 'discovering', tries: ap.tries + 1 });
      discover(ctx);
      return;
    case 'joined':
      if (ap.missed >= MAX_MISSED) {
        ctx.note(`Heard nothing from controller ${ap.controller}: looks for another`);
        become(ctx, { phase: 'discovering', tries: 1 });
        discover(ctx);
        return;
      }
      become(ctx, { ...ap, missed: ap.missed + 1 });
      send(ctx, ap.controller, { kind: 'capwap', type: 'echo-request' });
      ctx.setTimer(key, ECHO_INTERVAL);
      return;
  }
}

function onApMessage(ctx: IpContext, from: Ipv4Address, message: CapwapMessage) {
  const ap = ctx.state.apps.capwap;
  switch (message.type) {
    case 'discovery-response':
      if (ap.phase !== 'discovering') return;
      become(ctx, { phase: 'joining', controller: from, name: message.controller });
      send(ctx, from, {
        kind: 'capwap',
        type: 'join-request',
        ap: ctx.device.config.hostname,
        model: ctx.device.model,
      });
      ctx.setTimer(key, RETRY);
      return;
    case 'join-response':
      if (ap.phase !== 'joining' || ap.controller !== from) return;
      ctx.note(`Joined controller ${ap.name} at ${from}`);
      become(ctx, { phase: 'joined', controller: from, name: ap.name, wlans: [], missed: 0 });
      ctx.setTimer(key, ECHO_INTERVAL);
      return;
    case 'configuration-update':
      if (ap.phase !== 'joined' || ap.controller !== from) return;
      become(ctx, { ...ap, wlans: message.wlans });
      return;
    case 'echo-response':
      if (ap.phase === 'joined' && ap.controller === from) become(ctx, { ...ap, missed: 0 });
      return;
    default:
      return;
  }
}

/** The WLANs a controller pushes: its enabled ones, as the networks APs broadcast. */
function enabledWlans(ctx: IpContext): WirelessProfile[] {
  if (ctx.device.kind !== 'wlc') return [];
  return ctx.device.config.wlans.flatMap((wlan) =>
    wlan.enabled ? [{ ssid: wlan.ssid, security: wlan.security }] : [],
  );
}

function onControllerMessage(ctx: IpContext, from: Ipv4Address, message: CapwapMessage) {
  const controller = ctx.state.apps.wlc;
  switch (message.type) {
    case 'discovery-request':
      send(ctx, from, {
        kind: 'capwap',
        type: 'discovery-response',
        controller: ctx.device.config.hostname,
      });
      return;
    case 'join-request':
      controller.aps.set(from, {
        name: message.ap,
        model: message.model,
        joinedAt: ctx.now,
        lastSeen: ctx.now,
      });
      send(ctx, from, { kind: 'capwap', type: 'join-response' });
      send(ctx, from, { kind: 'capwap', type: 'configuration-update', wlans: enabledWlans(ctx) });
      return;
    case 'echo-request': {
      const joined = controller.aps.get(from);
      if (!joined) return;
      joined.lastSeen = ctx.now;
      send(ctx, from, { kind: 'capwap', type: 'echo-response' });
      return;
    }
    default:
      return;
  }
}

/** A CAPWAP control message on port 5246, for the AP or the controller it reached. */
export function onCapwapMessage(ctx: IpContext, packet: Ipv4Packet, datagram: UdpDatagram) {
  const message = datagram.payload;
  if (message.kind !== 'capwap' || datagram.dstPort !== APP_PORT.capwap) return;
  if (ctx.device.kind === 'lightweightAp') onApMessage(ctx, packet.src, message);
  else if (ctx.device.kind === 'wlc') onControllerMessage(ctx, packet.src, message);
}

/**
 * A controller's WLANs may have changed: push them to every AP that has joined, as the GUI's
 * Apply does.
 */
export function reconcileController(ctx: IpContext) {
  if (ctx.device.kind !== 'wlc') return;
  const wlans = enabledWlans(ctx);
  const json = JSON.stringify(wlans);
  const controller = ctx.state.apps.wlc;
  if (json === controller.pushed) return;
  controller.pushed = json;
  for (const address of liveAps(ctx).keys()) {
    send(ctx, address, { kind: 'capwap', type: 'configuration-update', wlans });
  }
}

/** The APs the controller still hears from, dropping any silent for too long. */
export function liveAps(ctx: IpContext): ReadonlyMap<Ipv4Address, JoinedAp> {
  const { aps } = ctx.state.apps.wlc;
  for (const [address, ap] of aps) if (ctx.now - ap.lastSeen > AP_TIMEOUT) aps.delete(address);
  return aps;
}

/** What a lightweight AP shows of itself: its address, its controller and what it broadcasts. */
export type LapStatus = {
  readonly address?: string;
  readonly phase: CapwapAp['phase'];
  readonly controller?: { readonly name: string; readonly address: Ipv4Address };
  readonly wlans: readonly WirelessProfile[];
};

export function lapStatus(ctx: IpContext): LapStatus {
  const ap = ctx.state.apps.capwap;
  const host = hostAddressingOf(ctx);
  const cidr = host && addressOf(host);
  return {
    ...(cidr && { address: `${cidr.address}/${cidr.prefixLength}` }),
    phase: ap.phase,
    ...((ap.phase === 'joined' || ap.phase === 'joining') && {
      controller: { name: ap.name, address: ap.controller },
    }),
    wlans: apBroadcasts(ap),
  };
}

/** The APs a controller has joined, as its GUI's AP list shows them. */
export type WlcStatus = {
  readonly aps: readonly {
    readonly name: string;
    readonly model: string;
    readonly address: Ipv4Address;
  }[];
};

export function wlcStatus(ctx: IpContext): WlcStatus {
  return {
    aps: [...liveAps(ctx)].map(([address, ap]) => ({ name: ap.name, model: ap.model, address })),
  };
}
