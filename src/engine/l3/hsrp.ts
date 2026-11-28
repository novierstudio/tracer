import type {
  Device,
  HsrpGroup,
  InterfaceId,
  Ipv4Address,
  MacAddress,
  PortId,
  SubinterfaceId,
} from '@/model';
import {
  HSRP_DEFAULT_AUTHENTICATION,
  HSRP_DEFAULT_DECREMENT,
  HSRP_GROUP_ADDRESS,
  hsrpPriority,
  hsrpTimers,
  hsrpVirtualMac,
  type HsrpVersion,
} from '@/model/hsrp';
import { parentPort } from '@/model/vlans';
import { ms, type SimTime } from '../core/time';
import type { DeviceContext, ModuleContext, SimModule, VirtualAddress } from '../module';
import {
  BROADCAST_MAC,
  multicastMac,
  UDP_PORT,
  type HsrpMessage,
  type HsrpOpcode,
  type HsrpState,
  type Ipv4Packet,
} from '../pdu';
import { arrival, packetIn } from '../routing/link';
import { ipInterfaces, isLan, sendOnLan, type IpInterface, type LanInterface } from './interfaces';
import { compareAddresses, inPrefix } from './ipv4';

/**
 * HSRP, version 1 or 2, as IOS runs it by RFC 2281. The routers on a LAN that share a group elect
 * one to answer for the group's virtual IP and MAC, the hosts' default gateway, and one to stand by
 * for it. Each speaks in hellos: the active router from the virtual MAC, the others from their own.
 * The highest priority wins, then the highest interface address. A standby router takes over when
 * the active router falls silent for a hold time or resigns; with `preempt`, a router of higher
 * priority takes over at once. A tracked interface going down lowers the router's priority.
 */

/** A router's state in one group. Tracer has no Learn state, since every group has its address. */
export type HsrpRouterState = Exclude<HsrpState, 'learn'>;

/** Why a group stays in Init. */
export type HsrpInitReason = 'interface-down' | 'no-ip' | 'wrong-subnet';

/** Another router in the group, as its last hello said. */
export type HsrpPeerStatus = {
  readonly address: Ipv4Address;
  readonly priority: number;
  /** The MAC its hellos come from: the virtual MAC for the active router. */
  readonly mac: MacAddress;
  /** Until its hold time runs out. */
  readonly expiresInMs: number;
};

/** A tracked interface and what it takes off the priority while its line protocol is down. */
export type HsrpTrackStatus = {
  readonly interface: InterfaceId;
  readonly up: boolean;
  readonly decrement: number;
};

/** One group on one interface as it runs now, for `show standby`. */
export type HsrpGroupStatus = {
  readonly interface: InterfaceId;
  readonly group: number;
  readonly state: HsrpRouterState;
  readonly initReason?: HsrpInitReason;
  /** `local` when this router holds the role. */
  readonly active: 'local' | HsrpPeerStatus | undefined;
  readonly standby: 'local' | HsrpPeerStatus | undefined;
  /** The configured priority less what tracked interfaces that are down take off. */
  readonly priority: number;
  readonly tracks: readonly HsrpTrackStatus[];
  /** Until the next hello, while the router sends them: in Speak, Standby and Active. */
  readonly nextHelloMs: number | undefined;
  readonly stateChanges: number;
  /** How long ago the state last changed. Undefined when it never has. */
  readonly sinceChangeMs: number | undefined;
};

type Peer = {
  readonly address: Ipv4Address;
  readonly priority: number;
  readonly mac: MacAddress;
  readonly expiresAt: SimTime;
};

/** One group on one interface. */
type GroupRun = {
  state: HsrpRouterState;
  /** In Listen and Speak, when the state's wait for other routers ends. */
  waitUntil: SimTime | undefined;
  /** The other router that is active, while its hellos keep coming. */
  active: Peer | undefined;
  /** The other router that stands by, while its hellos keep coming. */
  standby: Peer | undefined;
  /** The priority the router last sent, so a change in it goes out at once. */
  priority: number;
  /** The version the group ran in when it left Init. A change starts it over. */
  version: HsrpVersion;
  changes: number;
  changedAt: SimTime | undefined;
  nextHelloAt: SimTime | undefined;
};

export type HsrpModuleState = {
  /** By `<interface> <group>`. */
  readonly groups: Map<string, GroupRun>;
  nextPacketId: number;
};

type HsrpContext = ModuleContext<HsrpModuleState>;

/** A group as the device's config sets it. */
type GroupConfig = {
  readonly key: string;
  readonly interface: InterfaceId;
  readonly group: number;
  readonly version: HsrpVersion;
  readonly config: HsrpGroup;
};

const keyOf = (iface: InterfaceId, group: number) => `${iface} ${group}`;
const seconds = (value: number) => ms(value * 1000);
const at = (ctx: DeviceContext, delayMs: number) => (ctx.now + delayMs) as SimTime;

type Timer = { readonly kind: 'start' | 'poll' } | { readonly kind: 'hello' | 'tick'; key: string };

const timerKey = (timer: Timer) =>
  'key' in timer ? `hsrp ${timer.kind} ${timer.key}` : `hsrp ${timer.kind}`;

function parseTimer(key: string): Timer | undefined {
  const [prefix, kind, ...rest] = key.split(' ');
  if (prefix !== 'hsrp') return undefined;
  switch (kind) {
    case 'start':
    case 'poll':
      return { kind };
    case 'hello':
    case 'tick':
      return { kind, key: rest.join(' ') };
    default:
      return undefined;
  }
}

type Standby = { standbyVersion?: 2; standby?: Partial<Record<number, HsrpGroup>> };

/** Every HSRP group in the config: on a router's ports, subinterfaces and virtual interfaces, or on a switch's VLAN interfaces. */
function groupConfigs(device: Device): GroupConfig[] {
  const interfaces: [string, Standby | undefined][] =
    device.kind === 'router'
      ? [
          ...Object.entries(device.config.interfaces),
          ...Object.entries(device.config.subinterfaces),
          ...Object.entries(device.config.virtualInterfaces),
        ]
      : device.kind === 'switch'
        ? Object.entries(device.config.virtualInterfaces)
        : [];
  return interfaces.flatMap(([name, config]) => {
    const version: HsrpVersion = config?.standbyVersion ?? 1;
    return Object.entries(config?.standby ?? {}).flatMap(([number, group]) =>
      group
        ? [
            {
              key: keyOf(name as InterfaceId, Number(number)),
              interface: name as InterfaceId,
              group: Number(number),
              version,
              config: group,
            },
          ]
        : [],
    );
  });
}

/** Whether a tracked interface's line protocol is up: a port's link, or a working interface. */
function lineUp(ctx: DeviceContext, interfaces: readonly IpInterface[], id: InterfaceId): boolean {
  const { device } = ctx;
  if (device.ports.some((port) => port.id === id)) return ctx.portUp(id as PortId);
  if (device.kind === 'router' && id in device.config.subinterfaces) {
    const sub = device.config.subinterfaces[id as SubinterfaceId];
    return !sub?.shutdown && ctx.portUp(parentPort(id as SubinterfaceId));
  }
  return interfaces.some((iface) => iface.name === id);
}

function tracksOf(ctx: DeviceContext, interfaces: readonly IpInterface[], config: HsrpGroup) {
  return (config.track ?? []).map(
    (track): HsrpTrackStatus => ({
      interface: track.interface,
      up: lineUp(ctx, interfaces, track.interface),
      decrement: track.decrement ?? HSRP_DEFAULT_DECREMENT,
    }),
  );
}

/** The configured priority less each down tracked interface's decrement, as IOS lowers it. */
function priorityOf(ctx: DeviceContext, interfaces: readonly IpInterface[], config: HsrpGroup) {
  const lost = tracksOf(ctx, interfaces, config).reduce(
    (sum, track) => sum + (track.up ? 0 : track.decrement),
    0,
  );
  return Math.max(0, hsrpPriority(config) - lost);
}

/** The group's working LAN interface with the virtual IP in its subnet, or why it has none. */
function readiness(
  interfaces: readonly IpInterface[],
  group: GroupConfig,
): LanInterface | HsrpInitReason {
  const iface = interfaces.find((candidate) => candidate.name === group.interface);
  if (!iface || !isLan(iface)) return 'interface-down';
  const { ip } = group.config;
  if (!ip) return 'no-ip';
  return inPrefix(iface.cidr, ip) && ip !== iface.cidr.address ? iface : 'wrong-subnet';
}

const STATE_NAME: Record<HsrpRouterState, string> = {
  init: 'Init',
  listen: 'Listen',
  speak: 'Speak',
  standby: 'Standby',
  active: 'Active',
};

/** Packet Tracer logs every change into or out of Standby and Active, and no other. */
const logged = (state: HsrpRouterState) => state === 'standby' || state === 'active';

function send(
  ctx: HsrpContext,
  iface: LanInterface,
  group: GroupConfig,
  run: GroupRun,
  opcode: HsrpOpcode,
) {
  const { hello, hold } = hsrpTimers(group.config);
  const ip = group.config.ip;
  if (!ip) return;
  const message: HsrpMessage = {
    kind: 'hsrp',
    version: group.version,
    opcode,
    state: run.state,
    group: group.group,
    priority: run.priority,
    helloTime: hello,
    holdTime: hold,
    virtualIp: ip,
    authentication: HSRP_DEFAULT_AUTHENTICATION,
    ...(group.version === 2 && { identifier: iface.medium.mac }),
  };
  const dst = HSRP_GROUP_ADDRESS[group.version];
  const packet: Ipv4Packet = {
    kind: 'ipv4',
    src: iface.cidr.address,
    dst,
    ttl: 1,
    id: ctx.state.nextPacketId++,
    payload: { kind: 'udp', srcPort: UDP_PORT.hsrp, dstPort: UDP_PORT.hsrp, payload: message },
  };
  // The active router speaks from the virtual MAC, so switches learn where it is.
  const src =
    run.state === 'active' ? hsrpVirtualMac(group.version, group.group) : iface.medium.mac;
  sendOnLan(ctx, iface, { kind: 'ethernet', dst: multicastMac(dst), src, payload: packet });
}

/** A new active router tells the LAN where the virtual MAC is now, by gratuitous ARP. */
function announce(ctx: HsrpContext, iface: LanInterface, group: GroupConfig) {
  const ip = group.config.ip;
  if (!ip) return;
  const mac = hsrpVirtualMac(group.version, group.group);
  sendOnLan(ctx, iface, {
    kind: 'ethernet',
    dst: BROADCAST_MAC,
    src: mac,
    payload: { kind: 'arp', op: 'reply', senderMac: mac, senderIp: ip, targetMac: BROADCAST_MAC, targetIp: ip },
  });
}

/** Sends a hello now and the next one a hello time later. */
function hello(ctx: HsrpContext, iface: LanInterface, group: GroupConfig, run: GroupRun) {
  send(ctx, iface, group, run, 'hello');
  const period = seconds(hsrpTimers(group.config).hello);
  run.nextHelloAt = at(ctx, period);
  ctx.setTimer(timerKey({ kind: 'hello', key: group.key }), period);
}

/** Sets the group's one deadline timer to the nearest of its wait and its peers' hold times. */
function schedule(ctx: HsrpContext, group: GroupConfig, run: GroupRun) {
  const deadlines = [run.waitUntil, run.active?.expiresAt, run.standby?.expiresAt].filter(
    (deadline): deadline is SimTime => deadline !== undefined,
  );
  const key = timerKey({ kind: 'tick', key: group.key });
  if (deadlines.length === 0) ctx.clearTimer(key);
  else ctx.setTimer(key, ms(Math.max(0, Math.min(...deadlines) - ctx.now)));
}

/** Moves the group to `next`, logging it as Packet Tracer does, and starts what the state does. */
function enter(
  ctx: HsrpContext,
  iface: LanInterface | undefined,
  group: GroupConfig,
  run: GroupRun,
  next: HsrpRouterState,
) {
  const previous = run.state;
  if (previous === next) return;
  run.state = next;
  run.changes += 1;
  run.changedAt = ctx.now;
  if (logged(previous) || logged(next)) {
    ctx.syslog(
      `%HSRP-6-STATECHANGE: ${group.interface} Grp ${group.group} state ${STATE_NAME[previous]} -> ${STATE_NAME[next]}`,
    );
  }
  const hold = seconds(hsrpTimers(group.config).hold);
  run.waitUntil = next === 'listen' || next === 'speak' ? at(ctx, hold) : undefined;
  if (next === 'init' || next === 'listen') {
    run.nextHelloAt = undefined;
    ctx.clearTimer(timerKey({ kind: 'hello', key: group.key }));
  }
  if (next === 'init') {
    run.active = undefined;
    run.standby = undefined;
  }
  if (next === 'active') run.active = undefined;
  if (next === 'standby') run.standby = undefined;
  if (iface && (next === 'speak' || next === 'standby' || next === 'active')) {
    hello(ctx, iface, group, run);
    if (next === 'active') announce(ctx, iface, group);
  }
  schedule(ctx, group, run);
}

function newRun(version: HsrpVersion): GroupRun {
  return {
    state: 'init',
    waitUntil: undefined,
    active: undefined,
    standby: undefined,
    priority: 0,
    version,
    changes: 0,
    changedAt: undefined,
    nextHelloAt: undefined,
  };
}

/**
 * Brings every group in line with the config and the links. A group whose interface works and
 * whose virtual IP is in its subnet leaves Init to listen; one that loses either goes back, and an
 * active router that gives up the group while it can still send resigns. A new priority goes out
 * in a hello at once.
 */
function reconcile(ctx: HsrpContext) {
  const interfaces = ipInterfaces(ctx.device, ctx, undefined);
  const groups = groupConfigs(ctx.device);
  const { state } = ctx;
  let waiting = false;

  for (const [key, run] of state.groups) {
    if (groups.some((group) => group.key === key)) continue;
    // The group is gone from the config: an active router resigns as it goes.
    const [name = '', number = ''] = key.split(' ');
    const iface = interfaces.find((candidate) => candidate.name === name);
    const gone: GroupConfig = {
      key,
      interface: name as InterfaceId,
      group: Number(number),
      version: run.version,
      config: {},
    };
    stopGroup(ctx, iface && isLan(iface) ? iface : undefined, gone, run);
    state.groups.delete(key);
  }

  for (const group of groups) {
    let run = state.groups.get(group.key);
    if (!run) state.groups.set(group.key, (run = newRun(group.version)));
    const ready = readiness(interfaces, group);
    const priority = priorityOf(ctx, interfaces, group.config);
    if (typeof ready === 'string' || run.version !== group.version) {
      const iface = interfaces.find((candidate) => candidate.name === group.interface);
      if (run.state === 'active' && iface && isLan(iface)) {
        send(ctx, iface, { ...group, version: run.version }, run, 'resign');
      }
      enter(ctx, undefined, group, run, 'init');
      run.version = group.version;
      if (typeof ready === 'string') {
        run.priority = priority;
        waiting ||= ready === 'interface-down';
        continue;
      }
    }
    const changed = run.priority !== priority;
    run.priority = priority;
    if (run.state === 'init') enter(ctx, ready, group, run, 'listen');
    else if (changed && run.state !== 'listen') hello(ctx, ready, group, run);
  }
  // A VLAN interface comes up when spanning tree forwards, which no hook reports: look again soon.
  if (waiting) ctx.setTimer(timerKey({ kind: 'poll' }), seconds(1));
  else ctx.clearTimer(timerKey({ kind: 'poll' }));
}

/** Stops a group for good, as `no standby` removes it. An active router resigns if it can. */
function stopGroup(
  ctx: HsrpContext,
  iface: LanInterface | undefined,
  group: GroupConfig,
  run: GroupRun,
) {
  if (run.state === 'active' && iface) send(ctx, iface, group, run, 'resign');
  enter(ctx, undefined, group, run, 'init');
  ctx.clearTimer(timerKey({ kind: 'tick', key: group.key }));
}

/** The group's config and working interface, while it runs. */
function running(ctx: HsrpContext, key: string) {
  const run = ctx.state.groups.get(key);
  const group = groupConfigs(ctx.device).find((candidate) => candidate.key === key);
  if (!run || !group || run.state === 'init') return undefined;
  const ready = readiness(ipInterfaces(ctx.device, ctx, undefined), group);
  return typeof ready === 'string' ? undefined : { run, group, iface: ready };
}

/** The group's wait ended or a peer's hold time ran out. */
function onTick(ctx: HsrpContext, key: string) {
  const live = running(ctx, key);
  if (!live) return;
  const { run, group, iface } = live;
  const now = ctx.now;
  const activeLost = run.active !== undefined && now >= run.active.expiresAt;
  const standbyLost = run.standby !== undefined && now >= run.standby.expiresAt;
  if (activeLost) run.active = undefined;
  if (standbyLost) run.standby = undefined;
  const waited = run.waitUntil !== undefined && now >= run.waitUntil;
  if (waited) run.waitUntil = undefined;

  switch (run.state) {
    case 'listen':
      // A listener joins the election once the group lacks an active or a standby router.
      if ((waited || activeLost || standbyLost) && (!run.active || !run.standby)) {
        enter(ctx, iface, group, run, 'speak');
        return;
      }
      break;
    case 'speak':
      if (waited) {
        const standby = !run.standby || !outranks(run.standby, run, iface);
        enter(ctx, iface, group, run, !run.active ? 'active' : standby ? 'standby' : 'listen');
        return;
      }
      break;
    case 'standby':
      if (activeLost) {
        enter(ctx, iface, group, run, 'active');
        return;
      }
      break;
    case 'active':
    case 'init':
      break;
  }
  schedule(ctx, group, run);
}

/** Whether `peer` wins an election against this router: higher priority, then higher address. */
const outranks = (peer: Peer, run: GroupRun, iface: LanInterface) =>
  peer.priority > run.priority ||
  (peer.priority === run.priority && compareAddresses(peer.address, iface.cidr.address) > 0);

/** A hello, coup or resign from another router in one of the device's groups. */
function onMessage(ctx: HsrpContext, iface: LanInterface, packet: Ipv4Packet, mac: MacAddress) {
  const datagram = packet.payload;
  if (datagram.kind !== 'udp' || datagram.payload.kind !== 'hsrp') return;
  const message = datagram.payload;
  if (packet.src === iface.cidr.address || !inPrefix(iface.cidr, packet.src)) return;
  const live = running(ctx, keyOf(iface.name, message.group));
  if (!live || live.group.version !== message.version) return;
  if (message.authentication !== HSRP_DEFAULT_AUTHENTICATION) return;
  const { run, group } = live;

  const higher =
    message.priority > run.priority ||
    (message.priority === run.priority && compareAddresses(packet.src, iface.cidr.address) > 0);
  const peer: Peer = {
    address: packet.src,
    priority: message.priority,
    mac,
    expiresAt: at(ctx, seconds(message.holdTime)),
  };
  const forget = () => {
    if (run.active?.address === packet.src) run.active = undefined;
    if (run.standby?.address === packet.src) run.standby = undefined;
  };
  const move = (next: HsrpRouterState) => enter(ctx, iface, group, run, next);

  if (message.opcode === 'resign') {
    forget();
    if (run.state === 'standby') move('active');
    else if (run.state === 'listen' && !run.standby) move('speak');
    else schedule(ctx, group, run);
    return;
  }

  // A coup claims the active role at once, so it weighs as an active router's hello.
  const state = message.opcode === 'coup' ? 'active' : message.state;
  forget();
  if (state === 'active') {
    run.active = peer;
    if (run.state === 'active') {
      if (higher) move('speak');
      // Two active routers: the lower one hears a coup and stands down.
      else send(ctx, iface, group, run, 'coup');
    } else if ((run.state === 'speak' || run.state === 'standby') && !higher) {
      if (group.config.preempt) {
        run.active = undefined;
        enterActiveByCoup(ctx, iface, group, run);
        return;
      }
    }
  } else if (state === 'standby') {
    run.standby = peer;
    if (run.state === 'standby' && higher) move('listen');
    else if (run.state === 'speak') move(higher ? 'listen' : 'standby');
    else if (run.state === 'listen' && !higher) move('speak');
  } else if (state === 'speak') {
    // Standby goes to whoever outranks it, without preempt.
    if ((run.state === 'speak' || run.state === 'standby') && higher) move('listen');
  }
  schedule(ctx, group, run);
}

/** Preemption: the router takes the active role with a coup, then speaks as the active router. */
function enterActiveByCoup(
  ctx: HsrpContext,
  iface: LanInterface,
  group: GroupConfig,
  run: GroupRun,
) {
  enter(ctx, undefined, group, run, 'active');
  send(ctx, iface, group, run, 'coup');
  hello(ctx, iface, group, run);
  announce(ctx, iface, group);
}

function onTimer(ctx: HsrpContext, timer: Timer) {
  switch (timer.kind) {
    case 'start':
    case 'poll':
      reconcile(ctx);
      return;
    case 'tick':
      onTick(ctx, timer.key);
      return;
    case 'hello': {
      const live = running(ctx, timer.key);
      if (live && live.run.state !== 'listen') hello(ctx, live.iface, live.group, live.run);
      return;
    }
  }
}

const peerStatus = (ctx: DeviceContext, peer: Peer): HsrpPeerStatus => ({
  address: peer.address,
  priority: peer.priority,
  mac: peer.mac,
  expiresInMs: Math.max(0, peer.expiresAt - ctx.now),
});

/** Every group in the config as it runs now, in config order. */
export function hsrpStatus(ctx: HsrpContext): HsrpGroupStatus[] {
  const interfaces = ipInterfaces(ctx.device, ctx, undefined);
  return groupConfigs(ctx.device).map((group) => {
    const run = ctx.state.groups.get(group.key) ?? newRun(group.version);
    const ready = readiness(interfaces, group);
    const role = (held: HsrpRouterState, peer: Peer | undefined) =>
      run.state === held ? ('local' as const) : peer && peerStatus(ctx, peer);
    return {
      interface: group.interface,
      group: group.group,
      state: run.state,
      ...(run.state === 'init' && typeof ready === 'string' && { initReason: ready }),
      active: role('active', run.active),
      standby: role('standby', run.standby),
      priority: priorityOf(ctx, interfaces, group.config),
      tracks: tracksOf(ctx, interfaces, group.config),
      nextHelloMs:
        run.nextHelloAt === undefined ? undefined : Math.max(0, run.nextHelloAt - ctx.now),
      stateChanges: run.changes,
      sinceChangeMs: run.changedAt === undefined ? undefined : ctx.now - run.changedAt,
    };
  });
}

/**
 * HSRP on a router or a multilayer switch's VLAN interfaces. The engine starts it on every router
 * and switch; it idles until an interface has a `standby` group.
 */
export const hsrpModule: SimModule<HsrpModuleState> = {
  id: 'hsrp',
  init(ctx) {
    ctx.setTimer(timerKey({ kind: 'start' }), ms(0));
    return { groups: new Map(), nextPacketId: 1 };
  },
  onFrame(ctx, port, frame) {
    if (ctx.state.groups.size === 0) return;
    const datagram = packetIn(frame)?.payload;
    if (datagram?.kind !== 'udp' || datagram.dstPort !== UDP_PORT.hsrp) return;
    const interfaces = ipInterfaces(ctx.device, ctx, undefined);
    const groups = [HSRP_GROUP_ADDRESS[1], HSRP_GROUP_ADDRESS[2]];
    const arrived = arrival(ctx, interfaces, port, frame, groups);
    if (arrived?.mac && isLan(arrived.iface)) {
      onMessage(ctx, arrived.iface, arrived.packet, arrived.mac);
    }
  },
  onTimer(ctx, key) {
    const timer = parseTimer(key);
    if (timer) onTimer(ctx, timer);
  },
  onLinkChange: reconcile,
  onConfigChange: reconcile,
  /** Each active group's virtual IP and MAC, which the device's IP stack answers for. */
  virtualAddresses(ctx): VirtualAddress[] {
    return groupConfigs(ctx.device).flatMap((group) => {
      const run = ctx.state.groups.get(group.key);
      const ip = group.config.ip;
      if (run?.state !== 'active' || !ip) return [];
      return [{ interface: group.interface, address: ip, mac: hsrpVirtualMac(group.version, group.group) }];
    });
  },
};
