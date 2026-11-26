import type { SimEventBatch } from '@/engine/api';
import { ms, type SimTime } from '@/engine/core/time';
import { createEngine } from '@/engine/engine';
import { DNS_TTL, type DnsMessage, type DnsQuery, type DnsResponse } from '@/engine/dns';
import type { EventId, FrameEvent } from '@/engine/events';
import { byteLength, httpText, type HttpRequest, type HttpResponse } from '@/engine/http';
import {
  ALL_SPF_ROUTERS,
  INITIAL_SEQUENCE,
  LIMITED_BROADCAST,
  MAX_AGE,
  RIP_GROUP,
  UDP_PORT,
  type ArpPacket,
  type EthernetFrame,
  type Ipv4Packet,
  type Lsa,
  type LsaHeader,
  type NetworkLsa,
  type OspfDatabaseDescription,
  type OspfHello,
  type OspfLinkStateAck,
  type OspfLinkStateRequest,
  type OspfLinkStateUpdate,
  type OspfPacket,
  type RipMessage,
  type RouterLsa,
} from '@/engine/pdu';
import type { Ipv6Packet } from '@/engine/pdu6';
import { createSimService } from '@/engine/service';
import { STACKS } from '@/engine/stacks';
import { TCP_PORT, TCP_WINDOW, type TcpFlags, type TcpSegment } from '@/engine/tcp';
import { ip as parseIp, STP_CONVERGED } from '@/engine/testing';
import type {
  DeviceId,
  Ipv4Address,
  LinkId,
  MacAddress,
  PortId,
  PrefixLength,
  Topology,
} from '@/model';
import { ALL_NODES, ALL_ROUTERS, linkLocalOf, solicitedNode, type Ipv6Address } from '@/model/ipv6';

const mac = (n: number) => `02:00:00:00:00:${n.toString(16).padStart(2, '0')}` as MacAddress;
const ip = (text: string) => text as Ipv4Address;

export const arpRequest: ArpPacket = {
  kind: 'arp',
  op: 'request',
  senderMac: mac(1),
  senderIp: ip('192.168.1.10'),
  targetMac: mac(0),
  targetIp: ip('192.168.1.1'),
};

export const echoRequest: Ipv4Packet = {
  kind: 'ipv4',
  src: ip('192.168.1.10'),
  dst: ip('192.168.2.10'),
  ttl: 128,
  id: 1,
  payload: { kind: 'icmp', type: 'echo-request', id: 1, seq: 1 },
};

const ip6 = (text: string) => text as Ipv6Address;

/** PC1's MAC in the IPv6 samples, and its gateway R1's. */
export const PC1_MAC = '00:d0:97:12:34:56' as MacAddress;
export const R1_MAC = '00:d0:58:aa:bb:01' as MacAddress;

export const PC1_IPV6 = ip6('2001:db8:1::10');
export const R1_IPV6 = ip6('2001:db8:1::1');
export const R1_LINK_LOCAL = ip6('fe80::1');

/** PC1 pings 2001:db8:2::10 across R1. */
export const echoRequest6: Ipv6Packet = {
  kind: 'ipv6',
  src: PC1_IPV6,
  dst: ip6('2001:db8:2::10'),
  hopLimit: 128,
  payload: { kind: 'icmpv6', type: 'echo-request', id: 1, seq: 1 },
};

/** PC1 asks for its gateway's MAC, at the gateway's solicited-node group. */
export const neighborSolicitation: Ipv6Packet = {
  kind: 'ipv6',
  src: PC1_IPV6,
  dst: solicitedNode(R1_IPV6),
  hopLimit: 255,
  payload: { kind: 'icmpv6', type: 'neighbor-solicitation', target: R1_IPV6, sourceMac: PC1_MAC },
};

/** R1 answers `neighborSolicitation`. */
export const neighborAdvertisement: Ipv6Packet = {
  kind: 'ipv6',
  src: R1_IPV6,
  dst: PC1_IPV6,
  hopLimit: 255,
  payload: {
    kind: 'icmpv6',
    type: 'neighbor-advertisement',
    target: R1_IPV6,
    router: true,
    solicited: true,
    override: true,
    targetMac: R1_MAC,
  },
};

export const routerSolicitation: Ipv6Packet = {
  kind: 'ipv6',
  src: linkLocalOf(PC1_MAC),
  dst: ALL_ROUTERS,
  hopLimit: 255,
  payload: { kind: 'icmpv6', type: 'router-solicitation', sourceMac: PC1_MAC },
};

/** R1 advertises 2001:db8:1::/64 for SLAAC, with IOS's default lifetimes. */
export const routerAdvertisement: Ipv6Packet = {
  kind: 'ipv6',
  src: R1_LINK_LOCAL,
  dst: ALL_NODES,
  hopLimit: 255,
  payload: {
    kind: 'icmpv6',
    type: 'router-advertisement',
    curHopLimit: 64,
    managed: false,
    other: false,
    routerLifetime: 1800,
    sourceMac: R1_MAC,
    mtu: 1500,
    prefixes: [
      {
        prefix: { address: ip6('2001:db8:1::'), prefixLength: 64 },
        onLink: true,
        autonomous: true,
        validLifetime: 2592000,
        preferredLifetime: 604800,
      },
    ],
  },
};

/** A RIP message in a UDP datagram from 10.0.12.1, to RIPv2's group or, for v1, broadcast. */
export function ripPacket(message: RipMessage): Ipv4Packet {
  return {
    kind: 'ipv4',
    src: ip('10.0.12.1'),
    dst: message.version === 2 ? RIP_GROUP : LIMITED_BROADCAST,
    ttl: message.version === 2 ? 2 : 1,
    id: 4,
    payload: { kind: 'udp', srcPort: UDP_PORT.rip, dstPort: UDP_PORT.rip, payload: message },
  };
}

const prefix = (length: number) => length as PrefixLength;

/** Three routes: one a hop away, one two hops, and one poisoned. */
/** PC1 in `routedLab`, browsing to PC2 there as the web and DNS server. */
const CLIENT = ip('192.168.1.10');
const SERVER = ip('192.168.2.10');
const CLIENT_PORT = 49152;
const DNS_CLIENT_PORT = 51000;

export const dnsQuery: DnsQuery = { kind: 'dns', type: 'query', id: 0x1a2b, name: 'www.lab.local' };

export const dnsAnswer: DnsResponse = {
  ...dnsQuery,
  type: 'response',
  rcode: 'no-error',
  answers: [{ name: 'www.lab.local', address: SERVER, ttl: DNS_TTL }],
};

export const dnsNoSuchName: DnsResponse = {
  kind: 'dns',
  type: 'response',
  id: 0x1a2c,
  name: 'www.x.local',
  rcode: 'name-error',
  answers: [],
};

export const httpGet: HttpRequest = {
  kind: 'http',
  type: 'request',
  method: 'GET',
  path: '/',
  host: 'www.lab.local',
};

export const httpOk: HttpResponse = {
  kind: 'http',
  type: 'response',
  status: 200,
  reason: 'OK',
  contentType: 'text/html',
  body: '<html><body><h1>Welcome to www.lab.local</h1></body></html>',
};

const NO_FLAGS: TcpFlags = { syn: false, ack: false, fin: false, rst: false, psh: false };

function segment(
  from: 'client' | 'server',
  seq: number,
  ack: number,
  flags: Partial<TcpFlags>,
  payload?: TcpSegment['payload'],
): TcpSegment {
  const [srcPort, dstPort] =
    from === 'client' ? [CLIENT_PORT, TCP_PORT.http] : [TCP_PORT.http, CLIENT_PORT];
  return {
    kind: 'tcp',
    srcPort,
    dstPort,
    seq: seq >>> 0,
    ack: ack >>> 0,
    flags: { ...NO_FLAGS, ...flags },
    window: TCP_WINDOW,
    ...(payload && { payload }),
  };
}

const CLIENT_ISN = 4_000_000_000;
const SERVER_ISN = 123_456;
const GET = byteLength(httpText(httpGet));
const PAGE = byteLength(httpText(httpOk));

/**
 * The nine segments of fetching a page, in order: the handshake, the GET and its answer, then
 * the server's FIN and the client's. A SYN or FIN counts one, data its UTF-8 bytes.
 */
export const webSession: readonly TcpSegment[] = [
  segment('client', CLIENT_ISN, 0, { syn: true }),
  segment('server', SERVER_ISN, CLIENT_ISN + 1, { syn: true, ack: true }),
  segment('client', CLIENT_ISN + 1, SERVER_ISN + 1, { ack: true }),
  segment('client', CLIENT_ISN + 1, SERVER_ISN + 1, { psh: true, ack: true }, httpGet),
  segment('server', SERVER_ISN + 1, CLIENT_ISN + 1 + GET, { psh: true, ack: true }, httpOk),
  segment('server', SERVER_ISN + 1 + PAGE, CLIENT_ISN + 1 + GET, { fin: true, ack: true }),
  segment('client', CLIENT_ISN + 1 + GET, SERVER_ISN + 1 + PAGE, { ack: true }),
  segment('client', CLIENT_ISN + 1 + GET, SERVER_ISN + 2 + PAGE, { fin: true, ack: true }),
  segment('server', SERVER_ISN + 2 + PAGE, CLIENT_ISN + 2 + GET, { ack: true }),
];

/** What a server sends for a SYN to a port nothing listens on. */
export const tcpRefusal = (syn: TcpSegment): TcpSegment => ({
  ...syn,
  srcPort: syn.dstPort,
  dstPort: syn.srcPort,
  seq: 0,
  ack: (syn.seq + 1) >>> 0,
  flags: { ...NO_FLAGS, rst: true, ack: true },
});

/** A DNS message or TCP segment between PC1 and PC2: to a well-known port means from the client. */
export function webPacket(payload: DnsMessage | TcpSegment): Ipv4Packet {
  const toServer =
    payload.kind === 'tcp' ? payload.dstPort === TCP_PORT.http : payload.type === 'query';
  const [src, dst] = toServer ? [CLIENT, SERVER] : [SERVER, CLIENT];
  const base = { kind: 'ipv4', src, dst, ttl: 128, id: 21 } as const;
  if (payload.kind === 'tcp') return { ...base, payload };
  const [srcPort, dstPort] = toServer
    ? [DNS_CLIENT_PORT, UDP_PORT.dns]
    : [UDP_PORT.dns, DNS_CLIENT_PORT];
  return { ...base, payload: { kind: 'udp', srcPort, dstPort, payload } };
}

export const ripV2Response: RipMessage = {
  kind: 'rip',
  command: 'response',
  version: 2,
  entries: [
    { network: ip('192.168.1.0'), prefixLength: prefix(24), metric: 1 },
    { network: ip('10.0.23.0'), prefixLength: prefix(30), metric: 2 },
    { network: ip('172.16.0.0'), prefixLength: prefix(16), metric: 16 },
  ],
};

export const ripV1Response: RipMessage = {
  kind: 'rip',
  command: 'response',
  version: 1,
  entries: [{ network: ip('192.168.1.0'), metric: 1 }],
};

export const ripRequest = (version: 1 | 2): RipMessage => ({
  kind: 'rip',
  command: 'request',
  version,
});

/** An OSPF packet from 10.0.12.1, to AllSPFRouters unless `dst` says otherwise. TTL 1, as OSPF sends. */
export function ospfPacket(payload: OspfPacket, dst: Ipv4Address = ALL_SPF_ROUTERS): Ipv4Packet {
  return { kind: 'ipv4', src: ip('10.0.12.1'), dst, ttl: 1, id: 5, payload };
}

const R1 = ip('1.1.1.1');
const R2 = ip('2.2.2.2');

/** R1's hello on a LAN where it is DR and 10.0.12.2 is BDR, having heard 2.2.2.2 and 3.3.3.3. */
export const ospfHello: OspfHello = {
  kind: 'ospf',
  type: 'hello',
  routerId: R1,
  area: 0,
  networkMask: prefix(24),
  helloInterval: 10,
  deadInterval: 40,
  priority: 1,
  dr: ip('10.0.12.1'),
  bdr: ip('10.0.12.2'),
  neighbors: [R2, ip('3.3.3.3')],
};

/** R1's links: the LAN where it is DR, a serial link to 3.3.3.3, and that link's subnet. */
export const routerLsa: RouterLsa = {
  type: 'router',
  id: R1,
  advertisingRouter: R1,
  age: 1,
  sequence: INITIAL_SEQUENCE,
  links: [
    { type: 'transit', dr: ip('10.0.12.1'), address: ip('10.0.12.1'), metric: 1 },
    { type: 'point-to-point', neighbor: ip('3.3.3.3'), address: ip('10.0.13.1'), metric: 64 },
    { type: 'stub', network: ip('10.0.13.0'), prefixLength: prefix(30), metric: 64 },
  ],
};

/** The LAN's network LSA, from its DR R1, being flushed at MaxAge. */
export const networkLsa: NetworkLsa = {
  type: 'network',
  id: ip('10.0.12.1'),
  advertisingRouter: R1,
  age: MAX_AGE,
  sequence: INITIAL_SEQUENCE + 1,
  prefixLength: prefix(24),
  attached: [R1, R2],
};

const headerOf = ({ type, id, advertisingRouter, age, sequence }: Lsa): LsaHeader => ({
  type,
  id,
  advertisingRouter,
  age,
  sequence,
});

export const ospfDbd: OspfDatabaseDescription = {
  kind: 'ospf',
  type: 'dbd',
  routerId: R2,
  area: 0,
  mtu: 1500,
  init: false,
  more: true,
  master: true,
  sequence: 4242,
  headers: [headerOf(routerLsa), headerOf(networkLsa)],
};

export const ospfLsr: OspfLinkStateRequest = {
  kind: 'ospf',
  type: 'lsr',
  routerId: R1,
  area: 0,
  requests: [
    { type: 'router', id: R2, advertisingRouter: R2 },
    { type: 'network', id: ip('10.0.12.2'), advertisingRouter: R2 },
  ],
};

export const ospfLsu: OspfLinkStateUpdate = {
  kind: 'ospf',
  type: 'lsu',
  routerId: R1,
  area: 0,
  lsas: [routerLsa, networkLsa],
};

export const ospfAck: OspfLinkStateAck = {
  kind: 'ospf',
  type: 'lsack',
  routerId: R2,
  area: 0,
  headers: [headerOf(routerLsa)],
};

type Hop = {
  id: number;
  from: string;
  to: string;
  sentAt: number;
  time?: number;
  payload?: ArpPacket | Ipv4Packet | Ipv6Packet;
};

/** A delivered Ethernet frame on the link between two devices, named by their ids. */
export function hop({ id, from, to, sentAt, time = sentAt + 1, payload = echoRequest }: Hop) {
  const frame: EthernetFrame = { kind: 'ethernet', src: mac(1), dst: mac(2), payload };
  const event: FrameEvent = {
    kind: 'frame',
    id: id as EventId,
    time: time as SimTime,
    sentAt: sentAt as SimTime,
    link: `lnk_${[from, to].sort().join('_')}` as LinkId,
    from: { device: from as DeviceId, port: 'Fa0' as PortId },
    to: { device: to as DeviceId, port: 'Fa0' as PortId },
    frame,
    outcome: 'delivered',
  };
  return event;
}

export function batch(fields: Partial<SimEventBatch> = {}): SimEventBatch {
  const events = fields.events ?? [];
  return {
    now: (events.at(-1)?.time ?? 0) as SimTime,
    mode: 'simulation',
    playing: false,
    events,
    head: (events.at(-1)?.id ?? 0) as EventId,
    canStepBack: true,
    links: {},
    ...fields,
  };
}

/** Every frame of one ping from `from` to `target`, as the engine logs it. */
export function pingFrames(topology: Topology, from: DeviceId, target: string): FrameEvent[] {
  const engine = createEngine({ seed: 1, stacks: STACKS, linkDelay: ms(1) });
  const sim = createSimService({ engine, frames: { now: () => 0, request: () => {} } });
  sim.load(topology);
  engine.runUntil(STP_CONVERGED);
  const mark = engine.log.lastId;
  let done = false;
  const started = sim.ping(from, parseIp(target), { count: 1, timeoutMs: 1000 }, (event) => {
    if (event.kind === 'summary') done = true;
  });
  if (!started.ok) throw new Error(started.error);
  while (!done && engine.nextTime() !== undefined) engine.step();
  return engine.log.since(mark).filter((event) => event.kind === 'frame');
}
