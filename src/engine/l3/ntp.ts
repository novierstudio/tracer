import type { Ipv4Address } from '@/model';
import { serverServices } from '@/model/defaults';
import { APP_PORT, type NtpMessage } from '../apps';
import { ms, type SimTime } from '../core/time';
import type { DeviceContext } from '../module';
import type { Ipv4Packet, UdpDatagram } from '../pdu';
import { clockOf } from './appState';
import { timerKey, type IpContext } from './context';
import { originate } from './output';
import { udp } from './udp';

/** Seconds between polls, as Packet Tracer's routers poll: 2^4. */
export const NTP_POLL = 4;
const POLL_INTERVAL = ms(2 ** NTP_POLL * 1000);
/** How soon after boot, or after `ntp server`, the first poll goes. */
const FIRST_POLL = ms(1000);

/** The reference a Tracer server's NTP answers name: its own local clock. */
export const LOCAL_REFERENCE = '127.127.1.1';

/** One `ntp server` and what the client has heard from it. */
export type NtpPeer = {
  readonly address: Ipv4Address;
  /** The last 8 polls, newest in the low bit: 1 where an answer came. 377 octal is all 8. */
  reach: number;
  /** When the last poll went, for the round trip. */
  sentAt?: SimTime;
  /** The poll's transmit time, which the answer must echo. */
  sentClock?: number;
  /** What its last answer said, once one came. */
  heard?: {
    readonly at: SimTime;
    readonly stratum: number;
    readonly reference: string;
    /** The round trip, in milliseconds. */
    readonly delay: number;
  };
};

export type NtpClient = {
  readonly peers: NtpPeer[];
  /** The peer the clock follows, once one answered. */
  sync?: {
    readonly server: Ipv4Address;
    readonly stratum: number;
    /** The server's clock less the simulated time since boot, in milliseconds. */
    readonly offset: number;
    /** The server's clock when it last set this one, in milliseconds since 1970 UTC. */
    readonly reference: number;
    readonly at: SimTime;
  };
};

/** An NTP association as `show ntp associations` lists it. */
export type NtpAssociation = {
  readonly address: Ipv4Address;
  /** `127.127.1.1`, or `.INIT.` before an answer. */
  readonly reference: string;
  /** 16 before an answer. */
  readonly stratum: number;
  /** Seconds since the last answer, or undefined before one. */
  readonly when: number | undefined;
  /** Seconds between polls. */
  readonly poll: number;
  /** The reach register as a number: print it in octal. */
  readonly reach: number;
  readonly delay: number;
  readonly offset: number;
  /** The peer the clock follows: `*` in the listing. */
  readonly selected: boolean;
};

/** A device's clock and NTP, for `show clock`, `show ntp status` and `show ntp associations`. */
export type NtpStatus = {
  /** The device's clock now, in milliseconds since 1970 UTC. */
  readonly clock: number;
  /** Whether NTP set it. IOS prints `*` before an unset clock. */
  readonly synced: boolean;
  readonly associations: readonly NtpAssociation[];
  /** The peer the clock follows, its stratum, when it last set the clock and how long ago. */
  readonly sync?: {
    readonly server: Ipv4Address;
    readonly stratum: number;
    readonly reference: number;
    readonly lastUpdate: number;
  };
};

const pollKey = timerKey({ kind: 'app', name: 'ntp' });

const ntpServersOf = (device: DeviceContext['device']): readonly Ipv4Address[] =>
  device.kind === 'router' || device.kind === 'switch' ? (device.config.ntpServers ?? []) : [];

/** At boot, a router or switch with NTP servers polls them soon. */
export function bootNtp(ctx: DeviceContext) {
  if (ntpServersOf(ctx.device).length > 0) ctx.setTimer(pollKey, FIRST_POLL);
}

/**
 * Brings the client in line with the config's `ntp server` lines: a new one is polled soon, and a
 * removed one is forgotten, along with the time it set. With none left, the clock is unset.
 */
export function reconcileNtp(ctx: IpContext) {
  const servers = ntpServersOf(ctx.device);
  const { apps } = ctx.state;
  if (servers.length === 0) {
    apps.ntp = undefined;
    ctx.clearTimer(pollKey);
    return;
  }
  const before = apps.ntp;
  const peers = servers.map(
    (address) => before?.peers.find((peer) => peer.address === address) ?? { address, reach: 0 },
  );
  const sync = before?.sync && servers.includes(before.sync.server) ? before.sync : undefined;
  apps.ntp = { peers, ...(sync && { sync }) };
  if (!before || peers.some((peer) => !before.peers.includes(peer))) {
    ctx.setTimer(pollKey, FIRST_POLL);
  }
}

/** The poll timer fired: ask every server the time, then wait for the next poll. */
export function onNtpTimer(ctx: IpContext) {
  if (!ctx.state.apps.ntp) reconcileNtp(ctx);
  const client = ctx.state.apps.ntp;
  if (!client) return;
  const { time } = clockOf(ctx);
  for (const peer of client.peers) {
    peer.reach = (peer.reach << 1) & 0xff;
    peer.sentAt = ctx.now;
    peer.sentClock = time;
    const request: NtpMessage = {
      kind: 'ntp',
      mode: 'client',
      stratum: client.sync ? client.sync.stratum : 16,
      poll: NTP_POLL,
      reference: '',
      originate: 0,
      transmit: time,
    };
    originate(ctx, peer.address, udp(APP_PORT.ntp, APP_PORT.ntp, request));
  }
  ctx.setTimer(pollKey, POLL_INTERVAL);
}

/**
 * An NTP packet on port 123. A server with NTP on answers a request with its clock, as a
 * stratum 1 source. A client takes an answer to its last poll and sets its clock from the first
 * server that answers, allowing half the round trip for the answer's way back.
 */
export function onNtpMessage(ctx: IpContext, packet: Ipv4Packet, datagram: UdpDatagram) {
  const message = datagram.payload;
  if (message.kind !== 'ntp') return;
  if (message.mode === 'client') {
    if (ctx.device.kind !== 'server' || !serverServices(ctx.device.config).ntp.enabled) return;
    const answer: NtpMessage = {
      kind: 'ntp',
      mode: 'server',
      stratum: 1,
      poll: message.poll,
      reference: LOCAL_REFERENCE,
      originate: message.transmit,
      transmit: clockOf(ctx).time,
    };
    originate(ctx, packet.src, udp(APP_PORT.ntp, datagram.srcPort, answer), { src: packet.dst });
    return;
  }
  const client = ctx.state.apps.ntp;
  const peer = client?.peers.find((candidate) => candidate.address === packet.src);
  if (!client || !peer || peer.sentAt === undefined || message.originate !== peer.sentClock) return;
  const delay = ctx.now - peer.sentAt;
  const serverNow = message.transmit + delay / 2;
  peer.reach |= 1;
  peer.heard = {
    at: ctx.now,
    stratum: message.stratum,
    reference: message.reference,
    delay,
  };
  if (!client.sync || client.sync.server === peer.address) {
    client.sync = {
      server: peer.address,
      stratum: message.stratum + 1,
      offset: serverNow - ctx.now,
      reference: message.transmit,
      at: ctx.now,
    };
  }
}

const seconds = (since: number) => Math.floor(since / 1000);

/** The device's clock and its NTP associations now. */
export function ntpStatus(ctx: IpContext): NtpStatus {
  const { time, synced } = clockOf(ctx);
  const client = ctx.state.apps.ntp;
  const associations = (client?.peers ?? []).map((peer): NtpAssociation => ({
    address: peer.address,
    reference: peer.heard?.reference ?? '.INIT.',
    stratum: peer.heard?.stratum ?? 16,
    when: peer.heard ? seconds(ctx.now - peer.heard.at) : undefined,
    poll: 2 ** NTP_POLL,
    reach: peer.reach,
    delay: peer.heard?.delay ?? 0,
    // Once the clock follows the peer, the two agree.
    offset: 0,
    selected: client?.sync?.server === peer.address,
  }));
  const sync = client?.sync;
  return {
    clock: time,
    synced,
    associations,
    ...(sync && {
      sync: {
        server: sync.server,
        stratum: sync.stratum,
        reference: sync.reference,
        lastUpdate: seconds(ctx.now - sync.at),
      },
    }),
  };
}
