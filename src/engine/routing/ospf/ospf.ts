import type {
  Device,
  InterfaceId,
  Ipv4Address,
  MacAddress,
  OspfConfig,
  PrefixLength,
  RoutedInterface,
  Subinterface,
} from '@/model';
import { ms, type SimDuration, type SimTime } from '../../core/time';
import { ipInterfaces, type IpInterface } from '../../l3/interfaces';
import { compareAddresses, inPrefix, matchesWildcard, networkOf } from '../../l3/ipv4';
import { ADMINISTRATIVE_DISTANCE, type LearnedRoute } from '../../l3/routes';
import type { DeviceContext, ModuleContext, SimModule } from '../../module';
import {
  ALL_D_ROUTERS,
  ALL_SPF_ROUTERS,
  INITIAL_SEQUENCE,
  MAX_AGE,
  type Lsa,
  type LsaHeader,
  type NetworkLsa,
  type OspfDatabaseDescription,
  type OspfHello,
  type OspfLinkStateAck,
  type OspfLinkStateRequest,
  type OspfLinkStateUpdate,
  type OspfPacket,
  type RouterLink,
  type RouterLsa,
} from '../../pdu';
import { arrival, packetIn, sendOn } from '../link';
import { OSPF_TIMERS } from '../timers';
import { elect } from './election';
import { shortestPaths } from './spf';
import {
  aged,
  atLeast,
  compareInstances,
  headerOf,
  lsaKey,
  NO_ROUTER,
  parseTimer,
  timerKey,
  type Iface,
  type Neighbor,
  type OspfState,
  type Process,
  type SpfRoute,
  type Stored,
} from './state';
import type {
  OspfDesignated,
  OspfInterfaceStatus,
  OspfNeighborState,
  OspfNetworkType,
  OspfStatus,
} from './status';

/**
 * Single-area OSPFv2 as IOS runs it, by RFC 2328. Routers find neighbours with hellos, elect a DR
 * and BDR on each multi-access network, and bring adjacencies up to FULL by trading database
 * descriptions, requesting what they lack and flooding what changes, every LSA acknowledged.
 * Each router describes its links in a router LSA, each DR its network in a network LSA, and
 * every router runs Dijkstra over the same database to find its routes.
 */

type OspfContext = ModuleContext<OspfState>;
type Router = Extract<Device, { kind: 'router' }>;

/** What a packet says besides the header every OSPF packet carries. */
type Body =
  | Omit<OspfHello, 'kind' | 'routerId' | 'area'>
  | Omit<OspfDatabaseDescription, 'kind' | 'routerId' | 'area'>
  | Omit<OspfLinkStateRequest, 'kind' | 'routerId' | 'area'>
  | Omit<OspfLinkStateUpdate, 'kind' | 'routerId' | 'area'>
  | Omit<OspfLinkStateAck, 'kind' | 'routerId' | 'area'>;

/** Who a packet is for on its link: every OSPF router, the DR and BDR, or one neighbour. */
type Audience = 'all' | 'dr' | Neighbor;

/** Interface cost is this many kbit/s divided by the interface's bandwidth: 100 Mbit/s. */
const REFERENCE_BANDWIDTH = 100_000;

/** Each router refreshes its own LSAs this often, in seconds, so none ages out while it lives. */
const LS_REFRESH_TIME = 1800;

const MTU = 1500;

/** OSPF packets never leave their link. */
const OSPF_TTL = 1;

const seconds = (value: number): SimDuration => ms(value * 1000);
const timersOf = (ctx: DeviceContext) => OSPF_TIMERS[ctx.settings.routingTimers];
const ospfConfig = (device: Device): OspfConfig | undefined =>
  device.kind === 'router' ? device.config.ospf : undefined;

const STATE_NAMES: Record<OspfNeighborState, string> = {
  down: 'DOWN',
  init: 'INIT',
  '2way': '2WAY',
  exstart: 'EXSTART',
  exchange: 'EXCHANGE',
  loading: 'LOADING',
  full: 'FULL',
};

/** Bandwidth in kbit/s, as IOS gives each kind of interface by default. */
function bandwidth(device: Router, ip: IpInterface): number {
  switch (ip.medium.kind) {
    case 'loopback':
      return 8_000_000;
    case 'serial':
      return 1544;
    case 'ethernet': {
      const { port } = ip.medium;
      const kind = device.ports.find((candidate) => candidate.id === port)?.kind;
      const speed = device.config.interfaces[port]?.speed;
      return (speed ?? (kind === 'gigabitEthernet' ? 1000 : 100)) * 1000;
    }
    case 'svi':
      return 100_000;
  }
}

/** The config an interface's own OSPF settings live in: its port, subinterface or loopback. */
function settingsOf(device: Router, name: InterfaceId): RoutedInterface | Subinterface | undefined {
  const { interfaces, subinterfaces, virtualInterfaces } = device.config;
  return (
    (interfaces as Partial<Record<string, RoutedInterface>>)[name] ??
    (subinterfaces as Partial<Record<string, Subinterface>>)[name] ??
    (virtualInterfaces as Partial<Record<string, RoutedInterface>>)[name]
  );
}

type Plan = Pick<Iface, 'ip' | 'area' | 'type' | 'cost' | 'priority' | 'passive'>;

/**
 * The working interfaces OSPF runs on: each one the first matching `network` statement covers,
 * in that statement's area. Ethernet is broadcast, serial point-to-point.
 */
function plan(ctx: DeviceContext, device: Router, config: OspfConfig): Plan[] {
  return ipInterfaces(device, (port) => ctx.portUp(port), undefined).flatMap((ip): Plan[] => {
    const network = config.networks.find((candidate) =>
      matchesWildcard(ip.cidr.address, candidate.address, candidate.wildcard),
    );
    if (!network) return [];
    const type: OspfNetworkType =
      ip.medium.kind === 'loopback'
        ? 'loopback'
        : ip.medium.kind === 'serial'
          ? 'point-to-point'
          : 'broadcast';
    const settings = settingsOf(device, ip.name);
    const cost =
      settings?.ospfCost ?? Math.max(1, Math.floor(REFERENCE_BANDWIDTH / bandwidth(device, ip)));
    return [
      {
        ip,
        area: network.area,
        type,
        cost,
        priority: settings?.ospfPriority ?? 1,
        passive: config.passiveInterfaces.includes(ip.name),
      },
    ];
  });
}

/** `router-id`, else the highest loopback address, else the highest interface address. */
function pickRouterId(ctx: DeviceContext, config: OspfConfig): Ipv4Address | undefined {
  if (config.routerId) return config.routerId;
  const interfaces = ipInterfaces(ctx.device, (port) => ctx.portUp(port), undefined);
  const highest = (list: readonly IpInterface[]) =>
    list
      .map((iface) => iface.cidr.address)
      .sort(compareAddresses)
      .at(-1);
  return (
    highest(interfaces.filter((iface) => iface.medium.kind === 'loopback')) ?? highest(interfaces)
  );
}

// Sending

function send(ctx: OspfContext, process: Process, iface: Iface, body: Body, to: Audience) {
  const packet = {
    kind: 'ospf',
    routerId: process.routerId,
    area: iface.area,
    ...body,
  } as OspfPacket;
  // A point-to-point link has one neighbour, so everything goes to the group.
  const unicast = typeof to === 'object' && iface.type === 'broadcast' && to.mac !== undefined;
  const dst = unicast ? to.address : to === 'dr' ? ALL_D_ROUTERS : ALL_SPF_ROUTERS;
  sendOn(
    ctx,
    iface.ip,
    {
      kind: 'ipv4',
      src: iface.ip.cidr.address,
      dst,
      ttl: OSPF_TTL,
      id: ctx.state.nextPacketId++,
      payload: packet,
    },
    unicast ? to.mac : undefined,
  );
}

/** Where news goes on a link: from the DR or BDR to everyone, from anyone else to the DR and BDR. */
const floodAudience = (iface: Iface): Audience =>
  iface.type === 'broadcast' && iface.state !== 'dr' && iface.state !== 'backup' ? 'dr' : 'all';

function sendHello(ctx: OspfContext, process: Process, iface: Iface) {
  const { hello, dead } = timersOf(ctx);
  send(
    ctx,
    process,
    iface,
    {
      type: 'hello',
      networkMask: iface.ip.cidr.prefixLength,
      helloInterval: hello,
      deadInterval: dead,
      priority: iface.priority,
      dr: iface.dr,
      bdr: iface.bdr,
      neighbors: [...iface.neighbors.keys()].sort(compareAddresses),
    },
    'all',
  );
  iface.helloAt = (ctx.now + seconds(hello)) as SimTime;
  ctx.setTimer(timerKey({ kind: 'hello', iface: iface.name }), seconds(hello));
}

const armRetransmit = (ctx: OspfContext, iface: Iface, neighbor: Neighbor) =>
  ctx.setTimer(
    timerKey({ kind: 'rxmt', iface: iface.name, neighbor: neighbor.routerId }),
    seconds(timersOf(ctx).retransmit),
  );

function sendDbd(
  ctx: OspfContext,
  process: Process,
  iface: Iface,
  neighbor: Neighbor,
  flags: Pick<OspfDatabaseDescription, 'init' | 'more' | 'master'>,
  headers: readonly LsaHeader[],
) {
  const body = { type: 'dbd', mtu: MTU, ...flags, sequence: neighbor.ddSequence, headers } as const;
  neighbor.lastDbd = { kind: 'ospf', routerId: process.routerId, area: iface.area, ...body };
  send(ctx, process, iface, body, neighbor);
  armRetransmit(ctx, iface, neighbor);
}

function sendRequest(ctx: OspfContext, process: Process, iface: Iface, neighbor: Neighbor) {
  const requests = [...neighbor.requests.values()].map(({ type, id, advertisingRouter }) => ({
    type,
    id,
    advertisingRouter,
  }));
  send(ctx, process, iface, { type: 'lsr', requests }, neighbor);
  armRetransmit(ctx, iface, neighbor);
}

// The database

function databaseOf(process: Process, area: number): Map<string, Stored> {
  let database = process.areas.get(area);
  if (!database) process.areas.set(area, (database = new Map()));
  return database;
}

/** Every live LSA in the area by header, for a database description. */
function summary(ctx: OspfContext, process: Process, area: number): LsaHeader[] {
  return [...databaseOf(process, area)]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([, stored]) => aged(stored, ctx.now))
    .filter((lsa) => lsa.age < MAX_AGE)
    .map(headerOf);
}

function scheduleSpf(ctx: OspfContext, process: Process) {
  if (process.spfPending) return;
  process.spfPending = true;
  ctx.setTimer(timerKey({ kind: 'spf' }), seconds(timersOf(ctx).spfDelay));
}

/**
 * Sends an LSA on to every adjacent neighbour in its area but the one it came from, and keeps it
 * for each until acknowledged. On the network it came from, only the DR passes it on, since
 * everyone else heard it from the DR or will. Returns whether it went back out that interface,
 * which acknowledges it to the sender.
 */
function flood(
  ctx: OspfContext,
  process: Process,
  area: number,
  lsa: Lsa,
  from?: { readonly iface: Iface; readonly neighbor: Neighbor },
): boolean {
  const key = lsaKey(lsa);
  let back = false;
  for (const iface of process.interfaces.values()) {
    if (iface.area !== area || iface.passive || iface.type === 'loopback') continue;
    const onArrival = iface === from?.iface;
    if (onArrival && (iface.state !== 'dr' || from.neighbor.address === iface.bdr)) continue;
    const targets = [...iface.neighbors.values()].filter(
      (neighbor) => atLeast(neighbor.state, 'exchange') && neighbor !== from?.neighbor,
    );
    if (targets.length === 0) continue;
    for (const neighbor of targets) {
      neighbor.unacked.set(key, lsa);
      armRetransmit(ctx, iface, neighbor);
    }
    send(ctx, process, iface, { type: 'lsu', lsas: [lsa] }, floodAudience(iface));
    back ||= onArrival;
  }
  return back;
}

/** Installs a new instance of one of this router's own LSAs and floods it. */
function issue(ctx: OspfContext, process: Process, area: number, lsa: Lsa) {
  databaseOf(process, area).set(lsaKey(lsa), { lsa, receivedAt: ctx.now });
  flood(ctx, process, area, lsa);
}

/** The links this router's LSA describes in an area. */
function routerLinks(process: Process, area: number): RouterLink[] {
  const links: RouterLink[] = [];
  for (const iface of process.interfaces.values()) {
    if (iface.area !== area) continue;
    const { cidr } = iface.ip;
    const metric = iface.cost;
    const stub = {
      type: 'stub',
      network: networkOf(cidr).address,
      prefixLength: cidr.prefixLength,
      metric,
    } as const;
    const full = [...iface.neighbors.values()].filter((neighbor) => neighbor.state === 'full');
    switch (iface.type) {
      case 'loopback':
        links.push({ ...stub, network: cidr.address, prefixLength: 32 as PrefixLength });
        break;
      case 'point-to-point':
        for (const neighbor of full) {
          links.push({
            type: 'point-to-point',
            neighbor: neighbor.routerId,
            address: cidr.address,
            metric,
          });
        }
        links.push(stub);
        break;
      case 'broadcast': {
        // A transit network once the DR is fully adjacent; until then, a stub.
        const transit =
          iface.state === 'dr'
            ? full.length > 0
            : full.some((neighbor) => neighbor.address === iface.dr);
        links.push(
          transit ? { type: 'transit', dr: iface.dr, address: cidr.address, metric } : stub,
        );
        break;
      }
    }
  }
  return links;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Brings this router's own LSAs in line with its interfaces and neighbours: a router LSA in each
 * area it has an interface in, and a network LSA for each network where it is DR with a full
 * neighbour. One it no longer originates is flushed at MaxAge. A new instance goes out only when
 * the content changed, or with `refresh`, so calling this after any change is cheap.
 */
function originate(ctx: OspfContext, process: Process, refresh = false) {
  const { routerId } = process;
  const areas = new Set([...process.interfaces.values()].map((iface) => iface.area));
  for (const area of process.areas.keys()) if (!areas.has(area)) process.areas.delete(area);

  for (const area of areas) {
    const database = databaseOf(process, area);
    const own = (type: Lsa['type'], id: Ipv4Address) => {
      const stored = database.get(lsaKey({ type, id, advertisingRouter: routerId }));
      return stored && aged(stored, ctx.now);
    };
    const nextSequence = (current: Lsa | undefined) =>
      current ? current.sequence + 1 : INITIAL_SEQUENCE;

    const links = routerLinks(process, area);
    const current = own('router', routerId);
    const stale = !current || current.age >= MAX_AGE || current.type !== 'router';
    if (refresh || stale || !same(current.links, links)) {
      const lsa: RouterLsa = {
        type: 'router',
        id: routerId,
        advertisingRouter: routerId,
        age: 0,
        sequence: nextSequence(current),
        links,
      };
      issue(ctx, process, area, lsa);
    }

    const wanted = new Map<string, Omit<NetworkLsa, 'age' | 'sequence'>>();
    for (const iface of process.interfaces.values()) {
      if (iface.area !== area || iface.type !== 'broadcast' || iface.state !== 'dr') continue;
      const full = [...iface.neighbors.values()].filter((neighbor) => neighbor.state === 'full');
      if (full.length === 0) continue;
      const network = {
        type: 'network',
        id: iface.ip.cidr.address,
        advertisingRouter: routerId,
        prefixLength: iface.ip.cidr.prefixLength,
        attached: [routerId, ...full.map((neighbor) => neighbor.routerId)].sort(compareAddresses),
      } as const;
      wanted.set(lsaKey(network), network);
    }
    for (const [key, stored] of database) {
      const lsa = aged(stored, ctx.now);
      if (lsa.type !== 'network' || lsa.advertisingRouter !== routerId) continue;
      if (!wanted.has(key) && lsa.age < MAX_AGE)
        issue(ctx, process, area, { ...lsa, age: MAX_AGE });
    }
    for (const network of wanted.values()) {
      const held = own('network', network.id);
      const fresh = held?.type === 'network' && held.age < MAX_AGE;
      if (
        !refresh &&
        fresh &&
        same(held.attached, network.attached) &&
        held.prefixLength === network.prefixLength
      )
        continue;
      issue(ctx, process, area, { ...network, age: 0, sequence: nextSequence(held) });
    }
  }
  scheduleSpf(ctx, process);
}

/** Runs SPF in each area and keeps the routes, each aged from when it last changed. */
function runSpf(ctx: OspfContext, process: Process) {
  process.spfPending = false;
  const routes = new Map<string, SpfRoute>();
  const reached = new Set<Ipv4Address>();
  for (const [area, database] of process.areas) {
    const lsas = [...database.values()].map((stored) => aged(stored, ctx.now));
    const interfaces = [...process.interfaces.values()]
      .filter((iface) => iface.area === area)
      .map((iface) => ({ name: iface.name, address: iface.ip.cidr.address }));
    const result = shortestPaths(process.routerId, lsas, interfaces);
    for (const router of result.reached) reached.add(router);
    for (const { prefix, cost, hops } of result.paths) {
      const key = `${prefix.address}/${prefix.prefixLength}`;
      const held = routes.get(key);
      if (held && held.cost <= cost) continue;
      const before = process.routes.get(key);
      const unchanged = before && before.cost === cost && same(before.hops, hops);
      routes.set(key, { prefix, cost, hops, since: unchanged ? before.since : ctx.now });
    }
  }
  process.routes = routes;
  process.reached = [...reached].sort(compareAddresses);
}

// Neighbours

function setState(
  ctx: OspfContext,
  process: Process,
  iface: Iface,
  neighbor: Neighbor,
  state: OspfNeighborState,
  reason: string,
) {
  const before = neighbor.state;
  neighbor.state = state;
  if (state === 'full' || before === 'full') {
    ctx.note(
      `%OSPF-5-ADJCHG: Process ${process.id}, Nbr ${neighbor.routerId} on ${iface.name} from ${STATE_NAMES[before]} to ${STATE_NAMES[state]}, ${reason}`,
    );
  }
}

/** Forgets what an adjacency was exchanging, as it falls back to 2-Way or starts over. */
function resetAdjacency(ctx: OspfContext, iface: Iface, neighbor: Neighbor) {
  neighbor.requests.clear();
  neighbor.unacked.clear();
  neighbor.lastDbd = undefined;
  neighbor.summarySent = false;
  ctx.clearTimer(timerKey({ kind: 'rxmt', iface: iface.name, neighbor: neighbor.routerId }));
}

/** ExStart: claim to lead with an empty DBD, and see who the neighbour says leads. */
function startExchange(ctx: OspfContext, process: Process, iface: Iface, neighbor: Neighbor) {
  resetAdjacency(ctx, iface, neighbor);
  setState(ctx, process, iface, neighbor, 'exstart', 'Negotiation');
  neighbor.master = true;
  neighbor.ddSequence = 1 + Math.floor(ctx.random() * 0x7ffffffe);
  sendDbd(ctx, process, iface, neighbor, { init: true, more: true, master: true }, []);
}

function dropNeighbor(
  ctx: OspfContext,
  process: Process,
  iface: Iface,
  neighbor: Neighbor,
  reason: string,
) {
  setState(ctx, process, iface, neighbor, 'down', `Neighbor Down: ${reason}`);
  iface.neighbors.delete(neighbor.routerId);
  ctx.clearTimer(timerKey({ kind: 'dead', iface: iface.name, neighbor: neighbor.routerId }));
  ctx.clearTimer(timerKey({ kind: 'rxmt', iface: iface.name, neighbor: neighbor.routerId }));
}

/** On a multi-access network only the DR and BDR form adjacencies with everyone. */
const wantsAdjacency = (iface: Iface, neighbor: Neighbor) =>
  iface.type === 'point-to-point' ||
  (iface.state !== 'waiting' &&
    (iface.state === 'dr' ||
      iface.state === 'backup' ||
      neighbor.address === iface.dr ||
      neighbor.address === iface.bdr));

/** Elects the DR and BDR again, then starts or tears down adjacencies to match. */
function electDr(ctx: OspfContext, process: Process, iface: Iface) {
  if (iface.type !== 'broadcast' || iface.state === 'waiting') return;
  const { dr, bdr } = elect(process.routerId, iface);
  const own = iface.ip.cidr.address;
  iface.dr = dr;
  iface.bdr = bdr;
  iface.state = dr === own ? 'dr' : bdr === own ? 'backup' : 'drother';
  for (const neighbor of iface.neighbors.values()) {
    if (!atLeast(neighbor.state, '2way')) continue;
    const wanted = wantsAdjacency(iface, neighbor);
    if (wanted && neighbor.state === '2way') startExchange(ctx, process, iface, neighbor);
    if (!wanted && atLeast(neighbor.state, 'exstart')) {
      resetAdjacency(ctx, iface, neighbor);
      setState(ctx, process, iface, neighbor, '2way', 'Adjacency no longer needed');
    }
  }
}

/**
 * The network already has a BDR, or a DR without one, so there is no need to wait out the Wait
 * timer: once every neighbour heard is 2-Way, the election sees all of them and keeps the
 * sitting DR and BDR, rather than a newcomer electing itself from what little it has heard.
 */
function backupSeen(iface: Iface): boolean {
  const neighbors = [...iface.neighbors.values()];
  return (
    neighbors.every((neighbor) => atLeast(neighbor.state, '2way')) &&
    neighbors.some(
      ({ address, dr, bdr }) => bdr === address || (dr === address && bdr === NO_ROUTER),
    )
  );
}

/** The wait is over, or the network already has its DR and BDR: elect. */
function endWait(ctx: OspfContext, process: Process, iface: Iface) {
  ctx.clearTimer(timerKey({ kind: 'wait', iface: iface.name }));
  iface.state = 'drother';
  electDr(ctx, process, iface);
}

function onHello(
  ctx: OspfContext,
  process: Process,
  iface: Iface,
  hello: OspfHello,
  src: Ipv4Address,
  mac: MacAddress | undefined,
) {
  const { hello: interval, dead } = timersOf(ctx);
  if (hello.helloInterval !== interval || hello.deadInterval !== dead) {
    ctx.note(`OSPF: hello from ${hello.routerId} on ${iface.name} has other hello or dead timers`);
    return;
  }
  if (iface.type === 'broadcast' && hello.networkMask !== iface.ip.cidr.prefixLength) {
    ctx.note(`OSPF: hello from ${hello.routerId} on ${iface.name} has another network mask`);
    return;
  }
  let neighbor = iface.neighbors.get(hello.routerId);
  let changed = false;
  if (!neighbor) {
    neighbor = {
      routerId: hello.routerId,
      address: src,
      mac,
      priority: hello.priority,
      dr: hello.dr,
      bdr: hello.bdr,
      state: 'init',
      deadAt: ctx.now,
      master: false,
      ddSequence: 0,
      lastDbd: undefined,
      summarySent: false,
      requests: new Map(),
      unacked: new Map(),
    };
    iface.neighbors.set(hello.routerId, neighbor);
  } else {
    // A new priority, or a neighbour that starts or stops claiming DR or BDR, reruns the election.
    changed =
      neighbor.priority !== hello.priority ||
      (neighbor.dr === neighbor.address) !== (hello.dr === src) ||
      (neighbor.bdr === neighbor.address) !== (hello.bdr === src);
    neighbor.address = src;
    neighbor.mac = mac ?? neighbor.mac;
    neighbor.priority = hello.priority;
    neighbor.dr = hello.dr;
    neighbor.bdr = hello.bdr;
  }
  neighbor.deadAt = (ctx.now + seconds(dead)) as SimTime;
  ctx.setTimer(
    timerKey({ kind: 'dead', iface: iface.name, neighbor: hello.routerId }),
    seconds(dead),
  );

  const seesUs = hello.neighbors.includes(process.routerId);
  if (seesUs && neighbor.state === 'init') {
    setState(ctx, process, iface, neighbor, '2way', '2-Way Received');
    changed = true;
    if (iface.type === 'point-to-point') startExchange(ctx, process, iface, neighbor);
  } else if (!seesUs && atLeast(neighbor.state, '2way')) {
    resetAdjacency(ctx, iface, neighbor);
    setState(ctx, process, iface, neighbor, 'init', '1-Way Received');
    changed = true;
  }

  if (iface.state === 'waiting' && backupSeen(iface)) endWait(ctx, process, iface);
  else if (changed) electDr(ctx, process, iface);
  originate(ctx, process);
}

/** Notes which LSAs the neighbour has that this router lacks or holds an older instance of. */
function listWanted(
  ctx: OspfContext,
  process: Process,
  iface: Iface,
  neighbor: Neighbor,
  headers: readonly LsaHeader[],
) {
  const database = databaseOf(process, iface.area);
  for (const header of headers) {
    const stored = database.get(lsaKey(header));
    if (!stored || compareInstances(header, aged(stored, ctx.now)) > 0) {
      neighbor.requests.set(lsaKey(header), header);
    }
  }
}

/** Both sides have listed their databases: request what is missing, or the adjacency is FULL. */
function exchangeDone(ctx: OspfContext, process: Process, iface: Iface, neighbor: Neighbor) {
  if (neighbor.requests.size === 0) {
    setState(ctx, process, iface, neighbor, 'full', 'Exchange Done');
    if (neighbor.unacked.size === 0) {
      ctx.clearTimer(timerKey({ kind: 'rxmt', iface: iface.name, neighbor: neighbor.routerId }));
    }
    originate(ctx, process);
    return;
  }
  setState(ctx, process, iface, neighbor, 'loading', 'Exchange Done');
  sendRequest(ctx, process, iface, neighbor);
}

function mismatch(ctx: OspfContext, process: Process, iface: Iface, neighbor: Neighbor) {
  ctx.note(
    `OSPF: ${neighbor.routerId} on ${iface.name} is out of step, starting the exchange again`,
  );
  startExchange(ctx, process, iface, neighbor);
  originate(ctx, process);
}

/** The slave answers each DBD with its own: its database the first time, then empty ones. */
function answerAsSlave(
  ctx: OspfContext,
  process: Process,
  iface: Iface,
  neighbor: Neighbor,
  dbd: OspfDatabaseDescription,
) {
  const headers = neighbor.summarySent ? [] : summary(ctx, process, iface.area);
  neighbor.summarySent = true;
  sendDbd(ctx, process, iface, neighbor, { init: false, more: false, master: false }, headers);
  if (!dbd.more) exchangeDone(ctx, process, iface, neighbor);
}

/**
 * The database exchange. In ExStart the router with the higher router ID leads: it sends the
 * sequence numbers, and the other answers each with the same number. Every DBD lists headers;
 * Tracer's fit in one, so each side sends More only on its first, empty DBD.
 */
function onDbd(
  ctx: OspfContext,
  process: Process,
  iface: Iface,
  neighbor: Neighbor,
  dbd: OspfDatabaseDescription,
) {
  const resend = () => neighbor.lastDbd && send(ctx, process, iface, neighbor.lastDbd, neighbor);
  switch (neighbor.state) {
    case 'down':
    case 'init':
    case '2way':
      return;
    case 'exstart': {
      const higher = compareAddresses(dbd.routerId, process.routerId) > 0;
      if (dbd.init && dbd.more && dbd.master && dbd.headers.length === 0 && higher) {
        neighbor.master = false;
        neighbor.ddSequence = dbd.sequence;
        setState(ctx, process, iface, neighbor, 'exchange', 'Negotiation Done');
        answerAsSlave(ctx, process, iface, neighbor, dbd);
      } else if (!dbd.init && !dbd.master && dbd.sequence === neighbor.ddSequence && !higher) {
        setState(ctx, process, iface, neighbor, 'exchange', 'Negotiation Done');
        listWanted(ctx, process, iface, neighbor, dbd.headers);
        neighbor.ddSequence += 1;
        neighbor.summarySent = true;
        const headers = summary(ctx, process, iface.area);
        sendDbd(ctx, process, iface, neighbor, { init: false, more: false, master: true }, headers);
      }
      return;
    }
    case 'exchange':
      if (neighbor.master) {
        if (dbd.sequence === neighbor.ddSequence - 1 && !dbd.master) return;
        if (dbd.master || dbd.init || dbd.sequence !== neighbor.ddSequence) {
          mismatch(ctx, process, iface, neighbor);
          return;
        }
        listWanted(ctx, process, iface, neighbor, dbd.headers);
        if (!neighbor.lastDbd?.more && !dbd.more) {
          exchangeDone(ctx, process, iface, neighbor);
          return;
        }
        neighbor.ddSequence += 1;
        sendDbd(ctx, process, iface, neighbor, { init: false, more: false, master: true }, []);
        return;
      }
      if (dbd.sequence === neighbor.ddSequence) {
        resend();
        return;
      }
      if (!dbd.master || dbd.init || dbd.sequence !== neighbor.ddSequence + 1) {
        mismatch(ctx, process, iface, neighbor);
        return;
      }
      neighbor.ddSequence = dbd.sequence;
      listWanted(ctx, process, iface, neighbor, dbd.headers);
      answerAsSlave(ctx, process, iface, neighbor, dbd);
      return;
    case 'loading':
    case 'full':
      if (dbd.init) mismatch(ctx, process, iface, neighbor);
      else if (!neighbor.master && dbd.master && dbd.sequence === neighbor.ddSequence) resend();
      return;
  }
}

function onRequest(
  ctx: OspfContext,
  process: Process,
  iface: Iface,
  neighbor: Neighbor,
  request: OspfLinkStateRequest,
) {
  if (!atLeast(neighbor.state, 'exchange')) return;
  const database = databaseOf(process, iface.area);
  const lsas: Lsa[] = [];
  for (const key of request.requests) {
    const stored = database.get(lsaKey(key));
    if (!stored) {
      mismatch(ctx, process, iface, neighbor);
      return;
    }
    lsas.push(aged(stored, ctx.now));
  }
  send(ctx, process, iface, { type: 'lsu', lsas }, neighbor);
}

/**
 * RFC 2328's flooding procedure for each LSA in an update. A newer instance is installed, flooded
 * on and acknowledged. The same instance acknowledges one this router sent, or is acknowledged.
 * An older one gets this router's newer instance back. One of this router's own that comes back
 * newer, as after a reboot, is installed and then superseded or flushed by `originate`.
 */
function onUpdate(
  ctx: OspfContext,
  process: Process,
  iface: Iface,
  neighbor: Neighbor,
  update: OspfLinkStateUpdate,
) {
  if (!atLeast(neighbor.state, 'exchange')) return;
  const database = databaseOf(process, iface.area);
  const acks: LsaHeader[] = [];
  let changed = false;
  for (const lsa of update.lsas) {
    const key = lsaKey(lsa);
    const stored = database.get(key);
    const current = stored && aged(stored, ctx.now);
    const order = current ? compareInstances(lsa, current) : 1;
    if (order > 0) {
      if (lsa.age >= MAX_AGE && !current) {
        acks.push(headerOf(lsa));
        continue;
      }
      database.set(key, { lsa, receivedAt: ctx.now });
      changed = true;
      for (const other of process.interfaces.values()) {
        for (const peer of other.neighbors.values()) peer.unacked.delete(key);
      }
      const own = lsa.advertisingRouter === process.routerId;
      const back = !own && flood(ctx, process, iface.area, lsa, { iface, neighbor });
      if (!back) acks.push(headerOf(lsa));
    } else if (order === 0) {
      if (!neighbor.unacked.delete(key)) acks.push(headerOf(lsa));
    } else if (current) {
      send(ctx, process, iface, { type: 'lsu', lsas: [current] }, neighbor);
    }
    const wanted = neighbor.requests.get(key);
    if (wanted && order >= 0 && compareInstances(lsa, wanted) >= 0) neighbor.requests.delete(key);
  }
  if (acks.length > 0)
    send(ctx, process, iface, { type: 'lsack', headers: acks }, floodAudience(iface));
  if (neighbor.state === 'loading' && neighbor.requests.size === 0) {
    setState(ctx, process, iface, neighbor, 'full', 'Loading Done');
    changed = true;
  }
  if (changed) originate(ctx, process);
}

function onAck(neighbor: Neighbor, ack: OspfLinkStateAck) {
  for (const header of ack.headers) {
    const sent = neighbor.unacked.get(lsaKey(header));
    if (sent && compareInstances(header, sent) === 0) neighbor.unacked.delete(lsaKey(header));
  }
}

/** Sends again what the neighbour has not answered: the DBD while leading, requests, LSAs. */
function retransmit(ctx: OspfContext, process: Process, iface: Iface, neighbor: Neighbor) {
  let pending = false;
  const leading =
    neighbor.state === 'exstart' || (neighbor.state === 'exchange' && neighbor.master);
  if (leading && neighbor.lastDbd) {
    send(ctx, process, iface, neighbor.lastDbd, neighbor);
    pending = true;
  }
  if (neighbor.state === 'loading' && neighbor.requests.size > 0) {
    sendRequest(ctx, process, iface, neighbor);
    pending = true;
  }
  if (atLeast(neighbor.state, 'exchange') && neighbor.unacked.size > 0) {
    send(ctx, process, iface, { type: 'lsu', lsas: [...neighbor.unacked.values()] }, neighbor);
    pending = true;
  }
  if (pending) armRetransmit(ctx, iface, neighbor);
}

// The process

function addInterface(ctx: OspfContext, process: Process, planned: Plan) {
  const iface: Iface = {
    ...planned,
    name: planned.ip.name,
    state:
      planned.type === 'loopback'
        ? 'loopback'
        : planned.type === 'point-to-point'
          ? 'point-to-point'
          : 'waiting',
    dr: NO_ROUTER,
    bdr: NO_ROUTER,
    neighbors: new Map(),
    helloAt: undefined,
  };
  process.interfaces.set(iface.name, iface);
  const { wait } = timersOf(ctx);
  if (iface.type === 'broadcast')
    ctx.setTimer(timerKey({ kind: 'wait', iface: iface.name }), seconds(wait));
  if (!iface.passive && iface.type !== 'loopback') {
    iface.helloAt = ctx.now;
    ctx.setTimer(timerKey({ kind: 'hello', iface: iface.name }), ms(0));
  }
}

function removeInterface(ctx: OspfContext, process: Process, iface: Iface) {
  for (const neighbor of [...iface.neighbors.values()]) {
    dropNeighbor(ctx, process, iface, neighbor, 'Interface down or detached');
  }
  ctx.clearTimer(timerKey({ kind: 'hello', iface: iface.name }));
  ctx.clearTimer(timerKey({ kind: 'wait', iface: iface.name }));
  process.interfaces.delete(iface.name);
}

/** Brings the process's interfaces in line with the config and the links. */
function syncInterfaces(ctx: OspfContext, process: Process, device: Router, config: OspfConfig) {
  const plans = new Map(plan(ctx, device, config).map((planned) => [planned.ip.name, planned]));
  for (const iface of [...process.interfaces.values()]) {
    const planned = plans.get(iface.name);
    const kept =
      planned !== undefined &&
      planned.area === iface.area &&
      planned.type === iface.type &&
      planned.passive === iface.passive &&
      same(planned.ip.cidr, iface.ip.cidr);
    if (!kept) removeInterface(ctx, process, iface);
  }
  for (const planned of plans.values()) {
    const iface = process.interfaces.get(planned.ip.name);
    if (!iface) {
      addInterface(ctx, process, planned);
      continue;
    }
    iface.ip = planned.ip;
    iface.cost = planned.cost;
    if (iface.priority !== planned.priority) {
      iface.priority = planned.priority;
      electDr(ctx, process, iface);
    }
  }
}

function stopProcess(ctx: OspfContext) {
  const { process } = ctx.state;
  if (!process) return;
  for (const iface of [...process.interfaces.values()]) removeInterface(ctx, process, iface);
  ctx.clearTimer(timerKey({ kind: 'spf' }));
  ctx.clearTimer(timerKey({ kind: 'refresh' }));
  ctx.state.process = undefined;
}

/**
 * Brings OSPF in line with the config, the links and the lab's timers. A new process number,
 * `router-id` or timer profile starts the process over. Without a router ID to take, it waits.
 */
function reconcile(ctx: OspfContext) {
  const { device } = ctx;
  const config = ospfConfig(device);
  if (!config || device.kind !== 'router') {
    stopProcess(ctx);
    return;
  }
  const profile = ctx.settings.routingTimers;
  let { process } = ctx.state;
  if (
    process &&
    (process.id !== config.processId ||
      process.configuredId !== config.routerId ||
      process.timers !== profile)
  ) {
    stopProcess(ctx);
    process = undefined;
  }
  if (!process) {
    const routerId = pickRouterId(ctx, config);
    if (!routerId) return;
    process = {
      id: config.processId,
      routerId,
      configuredId: config.routerId,
      timers: profile,
      interfaces: new Map(),
      areas: new Map(),
      routes: new Map(),
      reached: [],
      spfPending: false,
    };
    ctx.state.process = process;
    ctx.setTimer(timerKey({ kind: 'refresh' }), seconds(LS_REFRESH_TIME));
  }
  syncInterfaces(ctx, process, device, config);
  originate(ctx, process);
}

function onTimer(ctx: OspfContext, key: string) {
  const timer = parseTimer(key);
  if (!timer) return;
  if (timer.kind === 'start') {
    reconcile(ctx);
    return;
  }
  const { process } = ctx.state;
  if (!process) return;
  switch (timer.kind) {
    case 'spf':
      runSpf(ctx, process);
      return;
    case 'refresh':
      originate(ctx, process, true);
      ctx.setTimer(timerKey({ kind: 'refresh' }), seconds(LS_REFRESH_TIME));
      return;
    case 'hello': {
      const iface = process.interfaces.get(timer.iface);
      if (iface && !iface.passive && iface.type !== 'loopback') sendHello(ctx, process, iface);
      return;
    }
    case 'wait': {
      const iface = process.interfaces.get(timer.iface);
      if (iface?.state !== 'waiting') return;
      endWait(ctx, process, iface);
      originate(ctx, process);
      return;
    }
    case 'dead': {
      const iface = process.interfaces.get(timer.iface);
      const neighbor = iface?.neighbors.get(timer.neighbor);
      if (!iface || !neighbor) return;
      dropNeighbor(ctx, process, iface, neighbor, 'Dead timer expired');
      electDr(ctx, process, iface);
      originate(ctx, process);
      return;
    }
    case 'rxmt': {
      const iface = process.interfaces.get(timer.iface);
      const neighbor = iface?.neighbors.get(timer.neighbor);
      if (iface && neighbor) retransmit(ctx, process, iface, neighbor);
      return;
    }
  }
}

function onPacket(
  ctx: OspfContext,
  process: Process,
  iface: Iface,
  src: Ipv4Address,
  dst: Ipv4Address,
  packet: OspfPacket,
  mac: MacAddress | undefined,
) {
  if (iface.passive || iface.type === 'loopback') return;
  // Only the DR and BDR listen to AllDRouters.
  if (dst === ALL_D_ROUTERS && iface.state !== 'dr' && iface.state !== 'backup') return;
  if (packet.routerId === process.routerId || !inPrefix(iface.ip.cidr, src)) return;
  if (packet.area !== iface.area) {
    ctx.note(
      `OSPF: ${packet.type} from ${packet.routerId} on ${iface.name} is for area ${packet.area}, not ${iface.area}`,
    );
    return;
  }
  if (packet.type === 'hello') {
    onHello(ctx, process, iface, packet, src, mac);
    return;
  }
  const neighbor = iface.neighbors.get(packet.routerId);
  if (!neighbor) return;
  switch (packet.type) {
    case 'dbd':
      onDbd(ctx, process, iface, neighbor, packet);
      return;
    case 'lsr':
      onRequest(ctx, process, iface, neighbor, packet);
      return;
    case 'lsu':
      onUpdate(ctx, process, iface, neighbor, packet);
      return;
    case 'lsack':
      onAck(neighbor, packet);
      return;
  }
}

// Queries

function designated(
  process: Process,
  iface: Iface,
  address: Ipv4Address,
): OspfDesignated | undefined {
  if (address === NO_ROUTER) return undefined;
  if (address === iface.ip.cidr.address) return { routerId: process.routerId, address };
  for (const neighbor of iface.neighbors.values()) {
    if (neighbor.address === address) return { routerId: neighbor.routerId, address };
  }
  return undefined;
}

function interfaceStatus(ctx: OspfContext, process: Process, iface: Iface): OspfInterfaceStatus {
  return {
    name: iface.name,
    cidr: iface.ip.cidr,
    area: iface.area,
    cost: iface.cost,
    networkType: iface.type,
    state: iface.state,
    priority: iface.priority,
    passive: iface.passive,
    dr: designated(process, iface, iface.dr),
    bdr: designated(process, iface, iface.bdr),
    helloDueMs: iface.helloAt === undefined ? undefined : Math.max(0, iface.helloAt - ctx.now),
    neighbors: [...iface.neighbors.values()]
      .sort((a, b) => compareAddresses(a.routerId, b.routerId))
      .map((neighbor) => ({
        routerId: neighbor.routerId,
        priority: neighbor.priority,
        state: neighbor.state,
        role:
          iface.type !== 'broadcast'
            ? undefined
            : neighbor.address === iface.dr
              ? 'dr'
              : neighbor.address === iface.bdr
                ? 'bdr'
                : 'drother',
        deadMs: Math.max(0, neighbor.deadAt - ctx.now),
        address: neighbor.address,
        interface: iface.name,
      })),
  };
}

/** The OSPF process's status, or undefined when the router has no `router ospf`. */
export function ospfStatus(ctx: OspfContext): OspfStatus | undefined {
  const config = ospfConfig(ctx.device);
  if (!config) return undefined;
  const { process } = ctx.state;
  const timers = timersOf(ctx);
  if (!process)
    return {
      processId: config.processId,
      routerId: undefined,
      timers,
      interfaces: [],
      sources: [],
    };
  const order = ipInterfaces(ctx.device, (port) => ctx.portUp(port), undefined).map(
    (ip) => ip.name,
  );
  const interfaces = [...process.interfaces.values()].sort(
    (a, b) => order.indexOf(a.name) - order.indexOf(b.name),
  );
  const sources = process.reached.flatMap((routerId) => {
    for (const database of process.areas.values()) {
      const stored = database.get(
        lsaKey({ type: 'router', id: routerId, advertisingRouter: routerId }),
      );
      if (stored) return [{ routerId, lastUpdateMs: ctx.now - stored.receivedAt }];
    }
    return [];
  });
  return {
    processId: process.id,
    routerId: process.routerId,
    timers,
    interfaces: interfaces.map((iface) => interfaceStatus(ctx, process, iface)),
    sources,
  };
}

/** OSPF on a router. The engine starts it on every router; it idles until `router ospf`. */
export const ospfModule: SimModule<OspfState> = {
  id: 'ospf',
  init(ctx) {
    ctx.setTimer(timerKey({ kind: 'start' }), ms(0));
    return { process: undefined, nextPacketId: 1 };
  },
  onFrame(ctx, port, frame) {
    const { process } = ctx.state;
    if (!process || packetIn(frame)?.payload.kind !== 'ospf') return;
    const interfaces = [...process.interfaces.values()].map((iface) => iface.ip);
    const arrived = arrival(ctx.device, interfaces, port, frame, [ALL_SPF_ROUTERS, ALL_D_ROUTERS]);
    const iface = arrived && process.interfaces.get(arrived.iface.name);
    if (!arrived || !iface || arrived.packet.payload.kind !== 'ospf') return;
    const { src, dst, payload } = arrived.packet;
    onPacket(ctx, process, iface, src, dst, payload, arrived.mac);
  },
  onTimer,
  onLinkChange: reconcile,
  onConfigChange: reconcile,
  routes(ctx): LearnedRoute[] {
    const { process } = ctx.state;
    if (!process) return [];
    return [...process.routes.values()].flatMap((route) =>
      route.hops.map((hop) => ({
        source: 'ospf' as const,
        prefix: route.prefix,
        distance: ADMINISTRATIVE_DISTANCE.ospf,
        metric: route.cost,
        via: hop.via,
        interface: hop.interface,
        ageMs: ctx.now - route.since,
      })),
    );
  },
};
