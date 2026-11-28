import type { Ipv4Address, ThingKind } from '@/model';
import { serverServices } from '@/model/defaults';
import { GATEWAY_ACCOUNT, iotOf, runsIotServer, THING_TYPES, thingState } from '@/model/iot';
import { APP_PORT, type IotMessage } from '../apps';
import { ms } from '../core/time';
import type { Ipv4Packet, UdpDatagram } from '../pdu';
import { hostAddressingOf, timerKey, type IpContext } from './context';
import { addressOf, gatewayOf } from './hostAddress';
import { originate } from './output';
import { udp } from './udp';

/**
 * IoT things and their registration server, as Packet Tracer runs them. A thing set to register
 * with its Home Gateway (its default gateway) or a remote IoT server registers once it has an
 * address, then reports its state when it changes and every 30 seconds. The server lists what
 * registered, and tells a thing to change an actuator when its web page asks.
 */

type State = Readonly<Record<string, string>>;

/** A thing's side: whether its server took it, and its state as the run changed it. */
export type IotThing = {
  phase: 'unregistered' | 'registering' | 'registered';
  /** The server it registers with, while it does. */
  server: Ipv4Address | undefined;
  /** The config's state as JSON when the run last took it, so a config edit wins. */
  seen: string;
  state: State;
  /** The state it last told its server, as JSON. */
  reported: string;
};

/** A thing a server has registered, by its name. */
export type RegisteredThing = {
  readonly name: string;
  readonly thing: ThingKind;
  readonly address: Ipv4Address;
  /** The account it registered under; a Home Gateway's things have none. */
  readonly owner: string;
  state: State;
  lastSeen: number;
};

/** A server's side: what registered, and who has signed in to its page, by address. */
export type IotServerState = {
  readonly things: Map<string, RegisteredThing>;
  readonly sessions: Map<Ipv4Address, string>;
};

export const idleThing = (): IotThing => ({
  phase: 'unregistered',
  server: undefined,
  seen: '',
  state: {},
  reported: '',
});

export const emptyIotServer = (): IotServerState => ({ things: new Map(), sessions: new Map() });

const RETRY = ms(3_000);
const HEARTBEAT = ms(30_000);
/** A server forgets a thing it has not heard from for this long. */
const THING_TIMEOUT = 100_000;

const key = timerKey({ kind: 'app', name: 'iot' });

const send = (ctx: IpContext, to: Ipv4Address, message: IotMessage) =>
  originate(ctx, to, udp(APP_PORT.iot, APP_PORT.iot, message));

/** A thing starts registering as soon as it boots. */
export function bootIot(ctx: Pick<IpContext, 'device' | 'setTimer'>) {
  if (iotOf(ctx.device)) ctx.setTimer(key, RETRY);
}

/** A thing's state now: its config's, unless the run changed it since. */
export function liveThingState(ctx: IpContext): State {
  const config = iotOf(ctx.device);
  const thing = ctx.state.apps.iot;
  if (!config) return thing.state;
  const fromConfig = thingState(config);
  const json = JSON.stringify(fromConfig);
  if (json !== thing.seen) {
    thing.seen = json;
    thing.state = fromConfig;
  }
  return thing.state;
}

/** The server the thing registers with now, or undefined while it has none to reach. */
function serverOf(ctx: IpContext): Ipv4Address | undefined {
  const server = iotOf(ctx.device)?.server;
  const host = hostAddressingOf(ctx);
  if (!server || !host || !addressOf(host)) return undefined;
  if (server.mode === 'remote') return server.address;
  return server.mode === 'gateway' ? gatewayOf(host) : undefined;
}

function register(ctx: IpContext, server: Ipv4Address) {
  const config = iotOf(ctx.device)!;
  const account = config.server.mode === 'remote' ? config.server : { username: '', password: '' };
  const state = liveThingState(ctx);
  ctx.state.apps.iot.phase = 'registering';
  ctx.state.apps.iot.server = server;
  send(ctx, server, {
    kind: 'iot',
    type: 'register',
    name: ctx.device.config.hostname,
    thing: config.thing,
    state,
    username: account.username,
    password: account.password,
  });
}

function report(ctx: IpContext) {
  const thing = ctx.state.apps.iot;
  if (thing.phase !== 'registered' || !thing.server) return;
  const state = liveThingState(ctx);
  thing.reported = JSON.stringify(state);
  send(ctx, thing.server, { kind: 'iot', type: 'report', name: ctx.device.config.hostname, state });
}

/** The thing's one timer: a registration retry, or once registered, its heartbeat. */
export function onIotTimer(ctx: IpContext) {
  if (!iotOf(ctx.device)) return;
  const thing = ctx.state.apps.iot;
  const server = serverOf(ctx);
  if (!server) {
    thing.phase = 'unregistered';
    thing.server = undefined;
    ctx.setTimer(key, RETRY);
    return;
  }
  if (thing.phase === 'registered' && thing.server === server) {
    report(ctx);
    ctx.setTimer(key, HEARTBEAT);
    return;
  }
  register(ctx, server);
  ctx.setTimer(key, RETRY);
}

/**
 * The thing's config may have changed: a state set in its inspector goes to its server, and a new
 * server setting makes it register again.
 */
export function reconcileThing(ctx: IpContext) {
  if (!iotOf(ctx.device)) return;
  const thing = ctx.state.apps.iot;
  const server = serverOf(ctx);
  if (thing.phase !== 'unregistered' && thing.server !== server) {
    thing.phase = 'unregistered';
    thing.server = undefined;
    ctx.setTimer(key, ms(0));
    return;
  }
  if (JSON.stringify(liveThingState(ctx)) !== thing.reported) report(ctx);
}

function onThingMessage(ctx: IpContext, from: Ipv4Address, message: IotMessage) {
  const thing = ctx.state.apps.iot;
  const config = iotOf(ctx.device);
  if (!config || from !== thing.server) return;
  switch (message.type) {
    case 'registered':
      if (!message.ok) {
        if (thing.phase === 'registering' && message.reason) ctx.note(message.reason);
        thing.phase = 'registering';
        return;
      }
      if (thing.phase !== 'registering') return;
      thing.phase = 'registered';
      thing.reported = JSON.stringify(liveThingState(ctx));
      ctx.setTimer(key, HEARTBEAT);
      return;
    case 'set': {
      const attribute = THING_TYPES[config.thing].attributes.find((a) => a.key === message.key);
      if (attribute?.role !== 'actuator' || !attribute.values.includes(message.value)) return;
      const state = { ...liveThingState(ctx), [message.key]: message.value };
      thing.state = state;
      ctx.learnThingState(state);
      report(ctx);
      return;
    }
    default:
      return;
  }
}

/** Whether `username` and `password` open an account on this server. A gateway has one. */
export function accountOpens(ctx: IpContext, username: string, password: string): boolean {
  const { device } = ctx;
  if (device.kind === 'server') {
    return serverServices(device.config).iot.users.some(
      (user) => user.username === username && user.password === password,
    );
  }
  return username === GATEWAY_ACCOUNT.username && password === GATEWAY_ACCOUNT.password;
}

function onServerMessage(ctx: IpContext, from: Ipv4Address, message: IotMessage) {
  const { things } = ctx.state.apps.iotServer;
  switch (message.type) {
    case 'register': {
      const gateway = ctx.device.kind !== 'server';
      if (!gateway && !accountOpens(ctx, message.username, message.password)) {
        send(ctx, from, {
          kind: 'iot',
          type: 'registered',
          ok: false,
          reason: `The IoT server refused the account ${message.username || '(none)'}`,
        });
        return;
      }
      things.set(message.name, {
        name: message.name,
        thing: message.thing,
        address: from,
        owner: gateway ? '' : message.username,
        state: message.state,
        lastSeen: ctx.now,
      });
      send(ctx, from, { kind: 'iot', type: 'registered', ok: true });
      return;
    }
    case 'report': {
      const known = things.get(message.name);
      if (!known || known.address !== from) {
        send(ctx, from, { kind: 'iot', type: 'registered', ok: false });
        return;
      }
      known.state = message.state;
      known.lastSeen = ctx.now;
      return;
    }
    default:
      return;
  }
}

/** An IoT message on its port, for the thing or for the server it reached. */
export function onIotMessage(ctx: IpContext, packet: Ipv4Packet, datagram: UdpDatagram) {
  const message = datagram.payload;
  if (message.kind !== 'iot' || datagram.dstPort !== APP_PORT.iot) return;
  if (iotOf(ctx.device)) onThingMessage(ctx, packet.src, message);
  else if (runsIotServer(ctx.device)) onServerMessage(ctx, packet.src, message);
}

/** The things a server still hears from, dropping any silent for too long. */
export function liveThings(ctx: IpContext): RegisteredThing[] {
  const { things } = ctx.state.apps.iotServer;
  for (const [name, thing] of things) {
    if (ctx.now - thing.lastSeen > THING_TIMEOUT) things.delete(name);
  }
  return [...things.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Tells a registered thing to set an actuator, and shows the change on the server at once. */
export function commandThing(ctx: IpContext, name: string, key: string, value: string): boolean {
  const thing = ctx.state.apps.iotServer.things.get(name);
  const attribute = thing && THING_TYPES[thing.thing].attributes.find((a) => a.key === key);
  if (!thing || attribute?.role !== 'actuator' || !attribute.values.includes(value)) return false;
  thing.state = { ...thing.state, [key]: value };
  send(ctx, thing.address, { kind: 'iot', type: 'set', key, value });
  return true;
}

/** What a thing shows of its registration. */
export type ThingStatus = {
  readonly phase: IotThing['phase'];
  readonly server?: Ipv4Address;
};

export function thingStatus(ctx: IpContext): ThingStatus {
  const { phase, server } = ctx.state.apps.iot;
  return { phase, ...(server && { server }) };
}

/** What an IoT server lists: each thing that registered, with its state. */
export type IotServerStatus = {
  readonly things: readonly {
    readonly name: string;
    readonly thing: ThingKind;
    readonly address: Ipv4Address;
    readonly owner: string;
    readonly state: State;
  }[];
};

export function iotServerStatus(ctx: IpContext): IotServerStatus {
  return {
    things: liveThings(ctx).map(({ name, thing, address, owner, state }) => ({
      name,
      thing,
      address,
      owner,
      state,
    })),
  };
}
