import type { FrameEvent, SentFrame } from '@/engine/events';
import type { Frame } from '@/engine/frame';
import type { DnsMessage } from '@/engine/dns';
import { ingressVlan } from '@/engine/l2/switching';
import { routesPackets } from '@/engine/l3/interfaces';
import {
  ALL_D_ROUTERS,
  ALL_SPF_ROUTERS,
  BROADCAST_MAC,
  EIGRP_GROUP,
  LIMITED_BROADCAST,
  multicastMac,
  RIP_GROUP,
  type ArpPacket,
  type DhcpMessage,
  type EigrpPacket,
  type Ipv4Packet,
  type OspfPacket,
  type RipMessage,
  type RipVersion,
} from '@/engine/pdu';
import { isNdp, type Ipv6Packet, type RouterAdvertisement } from '@/engine/pdu6';
import type { TcpSegment } from '@/engine/tcp';
import { shortPortName } from '@/features/canvas/cables';
import type { Device, Ipv4Address, MacAddress, PortId, VlanId } from '@/model';
import {
  ALL_NODES,
  ALL_ROUTERS,
  configuredIpv6Addresses,
  eui64Address,
  eui64Mac,
  interfaceLinkLocal,
  ipv6Enabled,
  isIpv6,
  isIpv6Multicast,
  linkLocalOf,
  solicitedNode,
  UNSPECIFIED_IPV6,
  type IpAddress,
  type Ipv6Address,
} from '@/model/ipv6';
import { eigrpType, type EigrpType } from './layers';

/**
 * What the receiving device did with a frame, read from the frames it sent while it handled
 * it. A drop is a failure worth a red cross; an ignore is a device minding its own business.
 */
export type Decision =
  | { kind: 'lost' }
  | { kind: 'link-test' }
  | { kind: 'spanning-tree'; out: readonly PortId[] }
  | { kind: 'routed'; out: PortId; ttl: readonly [number, number] }
  /** IPv6 has a hop limit where IPv4 has a TTL. */
  | { kind: 'routed'; out: PortId; hopLimit: readonly [number, number] }
  | { kind: 'switched'; out: PortId; retag: Retag }
  | { kind: 'flooded'; out: readonly PortId[]; vlan: VlanId | undefined; broadcast: boolean }
  /** `neighbor` answers a neighbor solicitation, `router` a router solicitation. */
  | { kind: 'replied'; reply: 'echo' | 'arp' | 'neighbor' | 'router'; out: PortId }
  /** An IPv4 next hop is resolved by ARP, an IPv6 one by a neighbor solicitation. */
  | { kind: 'resolving'; nextHop: IpAddress; out: PortId; forThisDevice: boolean }
  | { kind: 'learned'; ip: IpAddress; mac: MacAddress; released: readonly PortId[] }
  | { kind: 'received'; message: 'echo-reply' | 'time-exceeded' | 'unreachable'; from: IpAddress }
  /**
   * A device set to autoconfigure took a router advertisement: the addresses it formed by SLAAC,
   * and whether it now uses the router as its default gateway.
   */
  | {
      kind: 'autoconfigured';
      router: Ipv6Address;
      addresses: readonly Ipv6Address[];
      gateway: boolean;
    }
  | { kind: 'dhcp'; step: DhcpStep }
  /** A host took a DNS message or TCP segment for it: a step of fetching a web page. */
  | { kind: 'web'; step: WebStep }
  /** A router running RIP read a RIP message. `out` are the ports it sent RIP routes out of. */
  | { kind: 'rip'; command: RipMessage['command']; version: RipVersion; out: readonly PortId[] }
  /** A router running OSPF read an OSPF packet. `sent` is the OSPF it sent while it did. */
  | { kind: 'ospf'; type: OspfType; from: Ipv4Address; sent: readonly OspfSent[] }
  /**
   * A router in the packet's AS read an EIGRP packet from `from`. `ack` is the packet's ack
   * field, and `sent` the EIGRP it sent while it did.
   */
  | { kind: 'eigrp'; type: EigrpType; ack: number; from: Ipv4Address; sent: readonly EigrpSent[] }
  | { kind: 'dropped'; reason: DropReason; notified?: PortId }
  | { kind: 'ignored'; reason: IgnoreReason }
  | { kind: 'silent' };

/** What a DHCP server, relay agent or client did with a DHCP message. */
export type DhcpStep =
  | { kind: 'offered'; address: Ipv4Address; out: PortId }
  | { kind: 'acked'; address: Ipv4Address; out: PortId }
  | { kind: 'refused'; out: PortId }
  | { kind: 'released'; address: Ipv4Address }
  | { kind: 'relayed'; to: Ipv4Address; out: PortId }
  | { kind: 'relayed-back'; out: PortId }
  | { kind: 'requested'; address: Ipv4Address; out: PortId }
  | { kind: 'bound'; address: Ipv4Address }
  | { kind: 'restarted'; out: PortId };

/** What a host did with a DNS message or a TCP segment for it, read from what it sent back. */
export type WebStep =
  | { kind: 'dns-answered'; name: string; address: Ipv4Address | undefined; out: PortId }
  /** `connecting` is the port a SYN to the address went out of. */
  | { kind: 'dns-learned'; name: string; address: Ipv4Address | undefined; connecting?: PortId }
  | { kind: 'accepted'; port: number; out: PortId }
  | { kind: 'refused'; port: number; out: PortId }
  /** A client finished the handshake. `path` is what it then sent a GET for. */
  | { kind: 'connected'; path: string | undefined; out: PortId }
  | { kind: 'served'; path: string; status: string; closing: boolean; out: PortId }
  /** `response` is the status acknowledged, such as `200 OK`; without one, a FIN. */
  | { kind: 'acked'; response: string | undefined; closing: boolean; out: PortId }
  | { kind: 'took'; segment: 'ack' | 'rst' | 'other' };

type OspfType = OspfPacket['type'];

/** An OSPF packet a router sent while it handled another, and the port it went out of. */
export type OspfSent = { readonly type: OspfType; readonly port: PortId };

/** An EIGRP packet a router sent while it handled another, and the port it went out of. */
export type EigrpSent = { readonly type: EigrpType; readonly port: PortId };

/** How a switch changed a frame's 802.1Q tag on its way out. */
export type Retag =
  { kind: 'same' } | { kind: 'added'; vlan: VlanId } | { kind: 'removed'; vlan: VlanId };

export type DropReason =
  | { kind: 'ttl-expired' }
  | { kind: 'hop-limit-expired' }
  | { kind: 'no-route'; dst: IpAddress }
  | { kind: 'no-route-back'; dst: IpAddress }
  /** Nobody answered the router's neighbor solicitations for an IPv6 destination on its link. */
  | { kind: 'address-unreachable'; dst: Ipv6Address }
  /** An access list on the device denied the packet. */
  | { kind: 'acl-deny' }
  | { kind: 'tagged-on-access' }
  | { kind: 'vlan-not-allowed'; vlan: VlanId }
  | { kind: 'no-port'; vlan: VlanId }
  | { kind: 'no-offer' };

export type IgnoreReason =
  | { kind: 'other-mac'; dst: MacAddress }
  | { kind: 'arp-for-other'; target: Ipv4Address }
  | { kind: 'other-ip'; dst: IpAddress }
  /** An IPv6 multicast group the device has not joined. */
  | { kind: 'other-group'; group: Ipv6Address }
  | { kind: 'neighbor-for-other'; target: Ipv6Address }
  /** A router advertisement reached a device that does not autoconfigure. */
  | { kind: 'no-autoconfig' }
  | { kind: 'bpdu' }
  | { kind: 'dhcp-for-other'; client: MacAddress }
  | { kind: 'dhcp-not-server'; message: DhcpMessage['type'] }
  | { kind: 'no-rip' }
  | { kind: 'no-ospf' }
  | { kind: 'no-eigrp' }
  | { kind: 'eigrp-as'; asn: number; own: number }
  | { kind: 'rip-version'; version: RipVersion; accepts: RipVersion };

const ipv4Of = (frame: Frame): Ipv4Packet | undefined =>
  (frame.kind === 'hdlc' || frame.kind === 'ethernet') && frame.payload.kind === 'ipv4'
    ? frame.payload
    : undefined;

const dhcpOf = (frame: Frame): DhcpMessage | undefined => {
  const payload = ipv4Of(frame)?.payload;
  return payload?.kind === 'udp' && payload.payload.kind === 'dhcp' ? payload.payload : undefined;
};

const arpOf = (frame: Frame): ArpPacket | undefined =>
  frame.kind === 'ethernet' && frame.payload.kind === 'arp' ? frame.payload : undefined;

/**
 * The RIP message in a frame, when it is for this device: sent to RIPv2's group, broadcast, or
 * to one of its addresses.
 */
function ripFor(device: Device, frame: Frame): RipMessage | undefined {
  const packet = ipv4Of(frame);
  if (packet?.payload.kind !== 'udp' || packet.payload.payload.kind !== 'rip') return undefined;
  const local =
    packet.dst === RIP_GROUP ||
    packet.dst === LIMITED_BROADCAST ||
    ownAddresses(device).includes(packet.dst);
  return local ? packet.payload.payload : undefined;
}

const RIP_MAC = multicastMac(RIP_GROUP);

const sendsRip = (frame: Frame) => {
  const payload = ipv4Of(frame)?.payload;
  return payload?.kind === 'udp' && payload.payload.kind === 'rip';
};

/** A router without `version` reads either version; with one, only that version. */
function decideRip(device: Device, message: RipMessage, sent: readonly SentFrame[]): Decision {
  const rip = device.kind === 'router' ? device.config.rip : undefined;
  if (!rip) return { kind: 'ignored', reason: { kind: 'no-rip' } };
  if (rip.version !== undefined && rip.version !== message.version) {
    return {
      kind: 'ignored',
      reason: { kind: 'rip-version', version: message.version, accepts: rip.version },
    };
  }
  return {
    kind: 'rip',
    command: message.command,
    version: message.version,
    out: sent.filter((s) => sendsRip(s.frame)).map((s) => s.port),
  };
}

const ospfOf = (frame: Frame): OspfPacket | undefined => {
  const payload = ipv4Of(frame)?.payload;
  return payload?.kind === 'ospf' ? payload : undefined;
};

/** The OSPF packet in a frame, when it is for this device: to either OSPF group or one of its addresses. */
function ospfFor(device: Device, frame: Frame): OspfPacket | undefined {
  const packet = ipv4Of(frame);
  if (packet?.payload.kind !== 'ospf') return undefined;
  const local =
    packet.dst === ALL_SPF_ROUTERS ||
    packet.dst === ALL_D_ROUTERS ||
    ownAddresses(device).includes(packet.dst);
  return local ? packet.payload : undefined;
}

const OSPF_MACS: readonly MacAddress[] = [
  multicastMac(ALL_SPF_ROUTERS),
  multicastMac(ALL_D_ROUTERS),
];

function decideOspf(device: Device, packet: OspfPacket, sent: readonly SentFrame[]): Decision {
  if (device.kind !== 'router' || !device.config.ospf) {
    return { kind: 'ignored', reason: { kind: 'no-ospf' } };
  }
  return {
    kind: 'ospf',
    type: packet.type,
    from: packet.routerId,
    sent: sent.flatMap((s) => {
      const out = ospfOf(s.frame);
      return out ? [{ type: out.type, port: s.port }] : [];
    }),
  };
}

const eigrpOf = (frame: Frame): EigrpPacket | undefined => {
  const payload = ipv4Of(frame)?.payload;
  return payload?.kind === 'eigrp' ? payload : undefined;
};

type EigrpArrival = { readonly from: Ipv4Address; readonly packet: EigrpPacket };

/** The EIGRP packet in a frame and its sender, when it is for this device: to its group or one of its addresses. */
function eigrpFor(device: Device, frame: Frame): EigrpArrival | undefined {
  const packet = ipv4Of(frame);
  if (packet?.payload.kind !== 'eigrp') return undefined;
  const local = packet.dst === EIGRP_GROUP || ownAddresses(device).includes(packet.dst);
  return local ? { from: packet.src, packet: packet.payload } : undefined;
}

const EIGRP_MAC = multicastMac(EIGRP_GROUP);

function decideEigrp(
  device: Device,
  { from, packet }: EigrpArrival,
  sent: readonly SentFrame[],
): Decision {
  const eigrp = device.kind === 'router' ? device.config.eigrp : undefined;
  if (!eigrp) return { kind: 'ignored', reason: { kind: 'no-eigrp' } };
  if (eigrp.asn !== packet.asn) {
    return { kind: 'ignored', reason: { kind: 'eigrp-as', asn: packet.asn, own: eigrp.asn } };
  }
  return {
    kind: 'eigrp',
    type: eigrpType(packet),
    ack: packet.ack,
    from,
    sent: sent.flatMap((s) => {
      const out = eigrpOf(s.frame);
      return out ? [{ type: eigrpType(out), port: s.port }] : [];
    }),
  };
}

const isGroup = (mac: MacAddress) => (parseInt(mac.slice(0, 2), 16) & 1) === 1;

/** Every IPv4 address the device answers on, from its config. */
export function ownAddresses(device: Device): Ipv4Address[] {
  switch (device.kind) {
    case 'pc':
    case 'server':
      return device.config.ipv4.mode === 'static' && device.config.ipv4.address
        ? [device.config.ipv4.address.address]
        : [];
    case 'router':
    case 'switch': {
      const config = device.config;
      const interfaces = [
        ...Object.values(config.interfaces),
        ...Object.values(config.virtualInterfaces),
        ...(device.kind === 'router' ? Object.values(device.config.subinterfaces) : []),
      ];
      return interfaces.flatMap((iface) =>
        iface && 'ipv4' in iface && iface.ipv4 ? [iface.ipv4.address] : [],
      );
    }
  }
}

const ownMac = (device: Device, mac: MacAddress) =>
  device.ports.some((port) => port.kind !== 'serial' && port.mac === mac);

/** The same packet, one router further on. */
const isForwardOf = (packet: Ipv4Packet, next: Ipv4Packet) =>
  next.src === packet.src &&
  next.dst === packet.dst &&
  next.id === packet.id &&
  next.ttl === packet.ttl - 1;

/**
 * A switch's IP stack takes what arrives on a routed port, and what its VLAN interfaces answer
 * and route: frames for the switch's own MAC, and ARP requests for its own addresses. It bridges
 * the rest.
 */
function reachesIpStack(device: Extract<Device, { kind: 'switch' }>, event: FrameEvent): boolean {
  const { frame } = event;
  if (frame.kind !== 'ethernet' || frame.payload.kind === 'bpdu') return false;
  const arp = arpOf(frame);
  return (
    !device.config.interfaces[event.to.port]?.switchport ||
    ownMac(device, frame.dst) ||
    (arp?.op === 'request' && ownAddresses(device).includes(arp.targetIp))
  );
}

function decideSwitch(
  device: Extract<Device, { kind: 'switch' }>,
  event: FrameEvent,
  sent: readonly SentFrame[],
): Decision {
  const { frame } = event;
  if (frame.kind !== 'ethernet') return { kind: 'silent' };
  if (frame.payload.kind === 'bpdu') return { kind: 'spanning-tree', out: sent.map((s) => s.port) };
  const switchport = device.config.interfaces[event.to.port]?.switchport;
  const vlan = switchport ? ingressVlan(switchport, frame) : undefined;
  if (sent.length === 0) {
    if (switchport && vlan === undefined) {
      return switchport.mode === 'access'
        ? { kind: 'dropped', reason: { kind: 'tagged-on-access' } }
        : {
            kind: 'dropped',
            reason: { kind: 'vlan-not-allowed', vlan: frame.tag?.vlan ?? switchport.nativeVlan },
          };
    }
    if (vlan !== undefined) return { kind: 'dropped', reason: { kind: 'no-port', vlan } };
    return { kind: 'silent' };
  }
  const broadcast = frame.dst === BROADCAST_MAC;
  if (sent.length > 1 || isGroup(frame.dst)) {
    return { kind: 'flooded', out: sent.map((s) => s.port), vlan, broadcast };
  }
  const out = sent[0]!;
  const tagOut = out.frame.kind === 'ethernet' ? out.frame.tag : undefined;
  const retag: Retag =
    !frame.tag && tagOut
      ? { kind: 'added', vlan: tagOut.vlan }
      : frame.tag && !tagOut
        ? { kind: 'removed', vlan: frame.tag.vlan }
        : { kind: 'same' };
  return { kind: 'switched', out: out.port, retag };
}

function decideArp(device: Device, arp: ArpPacket, sent: readonly SentFrame[]): Decision {
  const reply = sent.find((s) => arpOf(s.frame)?.op === 'reply');
  if (arp.op === 'request') {
    if (reply) return { kind: 'replied', reply: 'arp', out: reply.port };
    if (!ownAddresses(device).includes(arp.targetIp)) {
      return { kind: 'ignored', reason: { kind: 'arp-for-other', target: arp.targetIp } };
    }
    return { kind: 'silent' };
  }
  return {
    kind: 'learned',
    ip: arp.senderIp,
    mac: arp.senderMac,
    released: sent.filter((s) => ipv4Of(s.frame)).map((s) => s.port),
  };
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
 * What a router or host did with a DHCP message, read from what it sent. A router serves or
 * relays what clients send and passes servers' replies back; a host takes the replies for its
 * own MAC and leaves the rest to servers.
 */
function decideDhcp(
  device: Device,
  packet: Ipv4Packet,
  message: DhcpMessage,
  sent: readonly SentFrame[],
): Decision | undefined {
  const answer = sent.flatMap(({ port, frame }) => {
    const reply = dhcpOf(frame);
    return reply?.xid === message.xid ? [{ port, reply, packet: ipv4Of(frame)! }] : [];
  })[0];
  if (device.kind === 'router') {
    if (!FROM_CLIENT[message.type]) {
      return answer
        ? { kind: 'dhcp', step: { kind: 'relayed-back', out: answer.port } }
        : undefined;
    }
    if (!answer) {
      if (message.type === 'release') {
        return { kind: 'dhcp', step: { kind: 'released', address: message.ciaddr } };
      }
      return message.type === 'discover' && packet.dst === LIMITED_BROADCAST
        ? { kind: 'dropped', reason: { kind: 'no-offer' } }
        : undefined;
    }
    const { reply, port: out } = answer;
    switch (reply.type) {
      case 'offer':
        return { kind: 'dhcp', step: { kind: 'offered', address: reply.yiaddr, out } };
      case 'ack':
        return { kind: 'dhcp', step: { kind: 'acked', address: reply.yiaddr, out } };
      case 'nak':
        return { kind: 'dhcp', step: { kind: 'refused', out } };
      default:
        return { kind: 'dhcp', step: { kind: 'relayed', to: answer.packet.dst, out } };
    }
  }
  if (device.kind !== 'pc' && device.kind !== 'server') return undefined;
  if (FROM_CLIENT[message.type]) {
    return { kind: 'ignored', reason: { kind: 'dhcp-not-server', message: message.type } };
  }
  if (!ownMac(device, message.chaddr)) {
    return { kind: 'ignored', reason: { kind: 'dhcp-for-other', client: message.chaddr } };
  }
  switch (message.type) {
    case 'offer':
      return answer
        ? { kind: 'dhcp', step: { kind: 'requested', address: message.yiaddr, out: answer.port } }
        : { kind: 'silent' };
    case 'ack':
      return { kind: 'dhcp', step: { kind: 'bound', address: message.yiaddr } };
    case 'nak': {
      const discover = sent.find(({ frame }) => dhcpOf(frame)?.type === 'discover');
      return discover
        ? { kind: 'dhcp', step: { kind: 'restarted', out: discover.port } }
        : { kind: 'silent' };
    }
    default:
      return undefined;
  }
}

const tcpOf = (frame: Frame): TcpSegment | undefined => {
  const payload = ipv4Of(frame)?.payload;
  return payload?.kind === 'tcp' ? payload : undefined;
};

const dnsOf = (frame: Frame): DnsMessage | undefined => {
  const payload = ipv4Of(frame)?.payload;
  return payload?.kind === 'udp' && payload.payload.kind === 'dns' ? payload.payload : undefined;
};

/** The HTTP message a segment carries, if it carries one. */
const httpOf = (segment: TcpSegment | undefined) =>
  segment?.payload?.kind === 'http' ? segment.payload : undefined;

const statusOf = (segment: TcpSegment | undefined) => {
  const message = httpOf(segment);
  return message?.type === 'response' ? `${message.status} ${message.reason}` : undefined;
};

function decideDns(message: DnsMessage, sent: readonly SentFrame[]): WebStep | undefined {
  if (message.type === 'query') {
    const reply = sent.flatMap(({ port, frame }) => {
      const answer = dnsOf(frame);
      return answer?.type === 'response' && answer.id === message.id ? [{ port, answer }] : [];
    })[0];
    if (!reply) return undefined;
    const address = reply.answer.answers[0]?.address;
    return { kind: 'dns-answered', name: message.name, address, out: reply.port };
  }
  const syn = sent.find(({ frame }) => {
    const segment = tcpOf(frame);
    return segment?.flags.syn && !segment.flags.ack;
  });
  return {
    kind: 'dns-learned',
    name: message.name,
    address: message.answers[0]?.address,
    ...(syn && { connecting: syn.port }),
  };
}

/** Reads the segments the host sent back on the same connection. */
function decideTcp(segment: TcpSegment, sent: readonly SentFrame[]): WebStep {
  const replies = sent.flatMap(({ port, frame }) => {
    const reply = tcpOf(frame);
    return reply?.srcPort === segment.dstPort && reply.dstPort === segment.srcPort
      ? [{ port, reply }]
      : [];
  });
  const out = replies[0]?.port;
  const { flags } = segment;
  const payload = httpOf(segment);
  if (out === undefined) {
    const bareAck = flags.ack && !flags.syn && !flags.fin && !flags.rst && !segment.payload;
    return { kind: 'took', segment: flags.rst ? 'rst' : bareAck ? 'ack' : 'other' };
  }
  const sentFlag = (flag: keyof TcpSegment['flags']) =>
    replies.some(({ reply }) => reply.flags[flag]);
  const closing = sentFlag('fin');
  if (sentFlag('rst')) return { kind: 'refused', port: segment.dstPort, out };
  if (flags.syn && !flags.ack) return { kind: 'accepted', port: segment.dstPort, out };
  if (flags.syn) {
    const request = replies.map(({ reply }) => httpOf(reply)).find((m) => m?.type === 'request');
    return { kind: 'connected', path: request?.type === 'request' ? request.path : undefined, out };
  }
  const status = replies.map(({ reply }) => statusOf(reply)).find(Boolean);
  if (payload?.type === 'request' && status) {
    return { kind: 'served', path: payload.path, status, closing, out };
  }
  return { kind: 'acked', response: statusOf(segment), closing, out };
}

function decideWeb(packet: Ipv4Packet, sent: readonly SentFrame[]): Decision | undefined {
  const { payload } = packet;
  const dns = dnsOf({ kind: 'hdlc', payload: packet });
  const step =
    payload.kind === 'tcp' ? decideTcp(payload, sent) : dns ? decideDns(dns, sent) : undefined;
  if (step) return { kind: 'web', step };
  return dns ? { kind: 'silent' } : undefined;
}

function decideIp(
  device: Device,
  packet: Ipv4Packet,
  sent: readonly SentFrame[],
  unicastToMe: boolean,
): Decision {
  // A DHCP host's address is not in its config, but a unicast frame for its MAC is for it.
  const leasedHere =
    unicastToMe &&
    (device.kind === 'pc' || device.kind === 'server') &&
    device.config.ipv4.mode === 'dhcp';
  const mine = leasedHere || ownAddresses(device).includes(packet.dst);
  for (const { port, frame } of sent) {
    const next = ipv4Of(frame);
    if (next && isForwardOf(packet, next)) {
      return { kind: 'routed', out: port, ttl: [packet.ttl, next.ttl] };
    }
  }
  for (const { port, frame } of sent) {
    const payload = ipv4Of(frame)?.payload;
    const message = payload?.kind === 'icmp' ? payload : undefined;
    if (message?.type === 'echo-reply') return { kind: 'replied', reply: 'echo', out: port };
    if (message?.type === 'time-exceeded') {
      return { kind: 'dropped', reason: { kind: 'ttl-expired' }, notified: port };
    }
    if (message?.type === 'destination-unreachable') {
      const reason: DropReason =
        message.code === 'admin-prohibited'
          ? { kind: 'acl-deny' }
          : { kind: 'no-route', dst: packet.dst };
      return { kind: 'dropped', reason, notified: port };
    }
    const arp = arpOf(frame);
    if (arp?.op === 'request') {
      return { kind: 'resolving', nextHop: arp.targetIp, out: port, forThisDevice: mine };
    }
  }
  const message = dhcpOf({ kind: 'hdlc', payload: packet });
  const dhcp = message && decideDhcp(device, packet, message, sent);
  if (dhcp) return dhcp;
  const web = mine ? decideWeb(packet, sent) : undefined;
  if (web) return web;
  if (mine && packet.payload.kind === 'icmp') {
    const message = packet.payload;
    switch (message.type) {
      case 'echo-reply':
        return { kind: 'received', message: 'echo-reply', from: packet.src };
      case 'time-exceeded':
        return { kind: 'received', message: 'time-exceeded', from: packet.src };
      case 'destination-unreachable':
        return { kind: 'received', message: 'unreachable', from: packet.src };
      case 'echo-request':
        return { kind: 'dropped', reason: { kind: 'no-route-back', dst: packet.src } };
    }
  }
  if (routesPackets(device)) {
    // A router tells nobody about a lost ICMP error, so errors cannot loop.
    return packet.ttl <= 1
      ? { kind: 'dropped', reason: { kind: 'ttl-expired' } }
      : { kind: 'dropped', reason: { kind: 'no-route', dst: packet.dst } };
  }
  return { kind: 'ignored', reason: { kind: 'other-ip', dst: packet.dst } };
}

const ipv6Of = (frame: Frame): Ipv6Packet | undefined =>
  (frame.kind === 'hdlc' || frame.kind === 'ethernet') && frame.payload.kind === 'ipv6'
    ? frame.payload
    : undefined;

/**
 * The IPv6 addresses the device's config gives it: every link-local and every configured address.
 * A host's SLAAC addresses are not among them.
 */
function ownIpv6Addresses(device: Device): Ipv6Address[] {
  switch (device.kind) {
    case 'pc':
    case 'server': {
      const { ipv6 } = device.config;
      const linkLocals = device.ports.flatMap((port) =>
        port.kind === 'serial' ? [] : [linkLocalOf(port.mac)],
      );
      return ipv6?.mode === 'static' && ipv6.address
        ? [...linkLocals, ipv6.address.address]
        : linkLocals;
    }
    case 'router': {
      const { interfaces, subinterfaces } = device.config;
      return [...Object.entries(interfaces), ...Object.entries(subinterfaces)].flatMap(
        ([id, iface]) => {
          const config = iface?.ipv6;
          // A subinterface builds its EUI-64 identifiers from its port's MAC.
          const mac = eui64Mac(device.ports, id.split('.')[0]);
          if (!config || !ipv6Enabled(config) || !mac) return [];
          const configured = configuredIpv6Addresses(config, mac).map((cidr) => cidr.address);
          return [interfaceLinkLocal(config, mac), ...configured];
        },
      );
    }
    case 'switch':
      return [];
  }
}

/**
 * The multicast groups the device listens to: all nodes, all routers on a router that routes
 * IPv6, and the solicited-node group of each of its addresses. A SLAAC address shares its
 * EUI-64 identifier, and so its group, with the link-local address.
 */
function ipv6Groups(device: Device, own: readonly Ipv6Address[]): Ipv6Address[] {
  if (own.length === 0) return [];
  const router = device.kind === 'router' && device.config.ipv6UnicastRouting === true;
  return [ALL_NODES, ...(router ? [ALL_ROUTERS] : []), ...own.map(solicitedNode)];
}

/** The same packet, one router further on. IPv6 has no identification field to match. */
const isForward6 = (packet: Ipv6Packet, next: Ipv6Packet) =>
  next.src === packet.src &&
  next.dst === packet.dst &&
  next.hopLimit === packet.hopLimit - 1 &&
  JSON.stringify(next.payload) === JSON.stringify(packet.payload);

/**
 * What a device set to autoconfigure took from a router advertisement: the addresses it checked
 * with duplicate address detection if it sent any, else the EUI-64 address in each /64 it may
 * autoconfigure in.
 */
function autoconfigure(
  device: Device,
  port: PortId,
  packet: Ipv6Packet,
  advert: RouterAdvertisement,
  sent: readonly SentFrame[],
): Decision {
  const host = device.kind === 'pc' || device.kind === 'server';
  const auto =
    device.kind === 'pc' || device.kind === 'server'
      ? device.config.ipv6?.mode === 'auto'
      : device.kind === 'router' && device.config.interfaces[port]?.ipv6?.autoconfig === true;
  if (!auto) return { kind: 'ignored', reason: { kind: 'no-autoconfig' } };
  const checked = sent.flatMap(({ frame }) => {
    const probe = ipv6Of(frame);
    return probe?.src === UNSPECIFIED_IPV6 && probe.payload.type === 'neighbor-solicitation'
      ? [probe.payload.target]
      : [];
  });
  const mac = eui64Mac(device.ports, port);
  const derived = advert.prefixes.flatMap(({ prefix, autonomous }) =>
    autonomous && prefix.prefixLength === 64 && mac ? [eui64Address(prefix.address, mac)] : [],
  );
  return {
    kind: 'autoconfigured',
    router: packet.src,
    addresses: checked.length > 0 ? checked : derived,
    gateway: host && advert.routerLifetime > 0,
  };
}

/**
 * What a device did with an IPv6 packet. Its answers come first, as for IPv4: a forwarded copy,
 * an ICMPv6 reply or error, or Neighbor Discovery.
 */
function decideIpv6(
  device: Device,
  frame: Frame,
  port: PortId,
  packet: Ipv6Packet,
  sent: readonly SentFrame[],
): Decision {
  const own = ownIpv6Addresses(device);
  const group = isIpv6Multicast(packet.dst);
  if (group && !ipv6Groups(device, own).includes(packet.dst)) {
    return { kind: 'ignored', reason: { kind: 'other-group', group: packet.dst } };
  }
  if (!group && frame.kind === 'ethernet' && !ownMac(device, frame.dst)) {
    return { kind: 'ignored', reason: { kind: 'other-mac', dst: frame.dst } };
  }
  // A host does not route, so a packet that reached it is for it, SLAAC addresses included.
  const mine =
    group || own.includes(packet.dst) || device.kind === 'pc' || device.kind === 'server';
  for (const { port: out, frame: next } of sent) {
    const forwarded = ipv6Of(next);
    if (forwarded && isForward6(packet, forwarded)) {
      return { kind: 'routed', out, hopLimit: [packet.hopLimit, forwarded.hopLimit] };
    }
  }
  const message = packet.payload;
  for (const { port: out, frame: next } of sent) {
    const reply = ipv6Of(next);
    const answer = reply?.payload;
    switch (answer?.type) {
      case 'echo-reply':
        return { kind: 'replied', reply: 'echo', out };
      case 'time-exceeded':
        return { kind: 'dropped', reason: { kind: 'hop-limit-expired' }, notified: out };
      case 'destination-unreachable': {
        const reason: DropReason =
          answer.code === 'no-route'
            ? { kind: 'no-route', dst: packet.dst }
            : { kind: 'address-unreachable', dst: packet.dst };
        return { kind: 'dropped', reason, notified: out };
      }
      case 'neighbor-advertisement':
        if (message.type === 'neighbor-solicitation') {
          return { kind: 'replied', reply: 'neighbor', out };
        }
        break;
      case 'router-advertisement':
        if (message.type === 'router-solicitation')
          return { kind: 'replied', reply: 'router', out };
        break;
      case 'neighbor-solicitation':
        // From the unspecified address, it checks an address of the device's own.
        if (reply?.src !== UNSPECIFIED_IPV6) {
          return { kind: 'resolving', nextHop: answer.target, out, forThisDevice: mine };
        }
        break;
    }
  }
  switch (message.type) {
    case 'neighbor-solicitation':
      return own.includes(message.target)
        ? { kind: 'silent' }
        : { kind: 'ignored', reason: { kind: 'neighbor-for-other', target: message.target } };
    case 'neighbor-advertisement': {
      const released = sent.filter((s) => {
        const waiting = ipv6Of(s.frame);
        return waiting && !isNdp(waiting.payload);
      });
      return {
        kind: 'learned',
        ip: message.target,
        mac: message.targetMac,
        released: released.map((s) => s.port),
      };
    }
    case 'router-solicitation':
      return { kind: 'silent' };
    case 'router-advertisement':
      return autoconfigure(device, port, packet, message, sent);
  }
  if (mine) {
    switch (message.type) {
      case 'echo-reply':
        return { kind: 'received', message: 'echo-reply', from: packet.src };
      case 'time-exceeded':
        return { kind: 'received', message: 'time-exceeded', from: packet.src };
      case 'destination-unreachable':
        return { kind: 'received', message: 'unreachable', from: packet.src };
      case 'echo-request':
        return { kind: 'dropped', reason: { kind: 'no-route-back', dst: packet.src } };
    }
  }
  if (device.kind === 'router' && device.config.ipv6UnicastRouting) {
    return packet.hopLimit <= 1
      ? { kind: 'dropped', reason: { kind: 'hop-limit-expired' } }
      : { kind: 'dropped', reason: { kind: 'no-route', dst: packet.dst } };
  }
  return { kind: 'ignored', reason: { kind: 'other-ip', dst: packet.dst } };
}

/** What `device`, the frame's receiver, did with it. Undefined when the device is gone. */
export function decide(event: FrameEvent, device: Device | undefined): Decision | undefined {
  if (event.outcome === 'link-down') return { kind: 'lost' };
  const { frame } = event;
  if (frame.kind === 'hello') return { kind: 'link-test' };
  if (!device) return undefined;
  const sent = event.sent ?? [];
  if (device.kind === 'switch' && !reachesIpStack(device, event)) {
    return decideSwitch(device, event, sent);
  }
  if (frame.kind === 'ethernet' && frame.payload.kind === 'bpdu') {
    return { kind: 'ignored', reason: { kind: 'bpdu' } };
  }
  const packet6 = ipv6Of(frame);
  if (packet6) return decideIpv6(device, frame, event.to.port, packet6, sent);
  const rip = ripFor(device, frame);
  const ospf = ospfFor(device, frame);
  const eigrp = eigrpFor(device, frame);
  const local =
    frame.kind !== 'ethernet' || frame.dst === BROADCAST_MAC || ownMac(device, frame.dst);
  // Every device sees the RIPv2, OSPF and EIGRP groups' frames, so it can say whether it runs them.
  if (
    !local &&
    !(rip && frame.dst === RIP_MAC) &&
    !(ospf && OSPF_MACS.includes(frame.dst)) &&
    !(eigrp && frame.dst === EIGRP_MAC)
  ) {
    return { kind: 'ignored', reason: { kind: 'other-mac', dst: frame.dst } };
  }
  if (rip) return decideRip(device, rip, sent);
  if (ospf) return decideOspf(device, ospf, sent);
  if (eigrp) return decideEigrp(device, eigrp, sent);
  const arp = arpOf(frame);
  if (arp) return decideArp(device, arp, sent);
  const packet = ipv4Of(frame);
  const unicastToMe = frame.kind === 'ethernet' && frame.dst !== BROADCAST_MAC;
  return packet ? decideIp(device, packet, sent, unicastToMe) : { kind: 'silent' };
}

/** The short reason the canvas shows on a drop marker, for decisions that are drops. */
export function dropLabel(decision: Decision | undefined): string | undefined {
  if (decision?.kind === 'lost') return 'Link down';
  if (decision?.kind !== 'dropped') return undefined;
  switch (decision.reason.kind) {
    case 'ttl-expired':
      return 'TTL expired';
    case 'hop-limit-expired':
      return 'Hop limit expired';
    case 'no-route':
      return 'No route';
    case 'no-route-back':
      return 'No route back';
    case 'address-unreachable':
      return 'No neighbor';
    case 'acl-deny':
      return 'ACL deny';
    case 'tagged-on-access':
    case 'vlan-not-allowed':
      return 'VLAN mismatch';
    case 'no-port':
      return 'Nowhere to send';
    case 'no-offer':
      return 'No offer';
  }
}

const list = (ports: readonly PortId[]) => {
  const names = ports.map(shortPortName);
  return names.length <= 1
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
};

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

function describeSwitched(name: string, out: PortId, retag: Retag): string {
  const port = shortPortName(out);
  switch (retag.kind) {
    case 'same':
      return `${name} switched it out ${port}, toward the destination MAC.`;
    case 'added':
      return `${name} switched it out trunk ${port} and added an 802.1Q tag for VLAN ${retag.vlan}.`;
    case 'removed':
      return `${name} switched it out access port ${port} and removed its VLAN ${retag.vlan} tag.`;
  }
}

function describeReplied(name: string, { reply, out }: Extract<Decision, { kind: 'replied' }>) {
  const port = shortPortName(out);
  switch (reply) {
    case 'echo':
      return `${name} is the destination, so it sent an echo reply back out ${port}.`;
    case 'arp':
      return `${name} owns the address asked for, so it sent an ARP reply with its MAC out ${port}.`;
    case 'neighbor':
      return `${name} owns the address asked for, so it sent a neighbor advertisement with its MAC out ${port}.`;
    case 'router':
      return `${name} routes IPv6, so it answered with a router advertisement out ${port}.`;
  }
}

function describeReceived(name: string, decision: Extract<Decision, { kind: 'received' }>) {
  switch (decision.message) {
    case 'echo-reply':
      return `The echo reply reached ${name}: the ping succeeded.`;
    case 'time-exceeded':
      return isIpv6(decision.from)
        ? `${name} heard from ${decision.from} that its packet ran out of hop limit on the way.`
        : `${name} heard from ${decision.from} that its packet ran out of TTL on the way.`;
    case 'unreachable':
      return `${name} heard from ${decision.from} that the destination cannot be reached.`;
  }
}

function describeDrop(name: string, { reason, notified }: Extract<Decision, { kind: 'dropped' }>) {
  const notice = (message: string) =>
    notified ? ` and sent ${message} back out ${shortPortName(notified)}` : '';
  switch (reason.kind) {
    case 'ttl-expired':
      return `The TTL ran out at ${name}, so it dropped the packet${notice('Time Exceeded')}.`;
    case 'hop-limit-expired':
      return `The hop limit ran out at ${name}, so it dropped the packet${notice('Time Exceeded')}.`;
    case 'no-route':
      return `${name} has no route to ${reason.dst}, so it dropped the packet${notice('Destination Unreachable')}.`;
    case 'no-route-back':
      return `${name} is the destination but has no route back to ${reason.dst}, so it could not reply.`;
    case 'address-unreachable':
      return `Nothing on ${name}'s link answered for ${reason.dst}, so it dropped the packet${notice('Destination Unreachable (address unreachable)')}.`;
    case 'acl-deny':
      return `An access list on ${name} denied the packet, so it dropped it${notice('Destination Unreachable (administratively prohibited)')}.`;
    case 'tagged-on-access':
      return `${name} dropped it: a tagged frame arrived on an access port.`;
    case 'vlan-not-allowed':
      return `${name} dropped it: the trunk does not allow VLAN ${reason.vlan}.`;
    case 'no-port':
      return `${name} dropped it: no other port is in VLAN ${reason.vlan}.`;
    case 'no-offer':
      return `${name} sent no offer: it has no DHCP pool for this network, or no free address left in it.`;
  }
}

const DHCP_NAMES: Record<DhcpMessage['type'], string> = {
  discover: 'a Discover',
  request: 'a Request',
  release: 'a Release',
  offer: 'an Offer',
  ack: 'an Ack',
  nak: 'a Nak',
};

function describeDhcp(name: string, step: DhcpStep): string {
  switch (step.kind) {
    case 'offered':
      return `${name}'s DHCP server offered ${step.address} and sent the Offer out ${shortPortName(step.out)}.`;
    case 'acked':
      return `${name}'s DHCP server leased ${step.address} to the client and sent an Ack out ${shortPortName(step.out)}.`;
    case 'refused':
      return `${name}'s DHCP server cannot grant that address, so it sent a Nak out ${shortPortName(step.out)}.`;
    case 'released':
      return `${name}'s DHCP server took ${step.address} back, free for the next client.`;
    case 'relayed':
      return `${name} relayed it to DHCP server ${step.to} out ${shortPortName(step.out)}, with its own address as the relay agent.`;
    case 'relayed-back':
      return `${name} passed the server's reply back to the client's network out ${shortPortName(step.out)}.`;
    case 'requested':
      return `${name} took the offer of ${step.address} and broadcast a Request for it out ${shortPortName(step.out)}.`;
    case 'bound':
      return `${name} now has ${step.address}: the DHCP server confirmed the lease.`;
    case 'restarted':
      return `${name} was refused, so it starts over with a Discover out ${shortPortName(step.out)}.`;
  }
}

function describeWeb(name: string, step: WebStep): string {
  switch (step.kind) {
    case 'dns-answered':
      return step.address
        ? `${name} looked up ${step.name} and sent back its address, ${step.address}, out ${shortPortName(step.out)}.`
        : `${name} knows no host named ${step.name}, so it answered that there is no such name out ${shortPortName(step.out)}.`;
    case 'dns-learned':
      if (!step.address)
        return `${name} heard that no host is named ${step.name}, so it cannot connect.`;
      return step.connecting
        ? `${name} learned that ${step.name} is at ${step.address} and opened a TCP connection to it with a SYN out ${shortPortName(step.connecting)}.`
        : `${name} learned that ${step.name} is at ${step.address}.`;
    case 'accepted':
      return `${name} is listening on port ${step.port}, so it answered the SYN with a SYN+ACK out ${shortPortName(step.out)}.`;
    case 'refused':
      return `${name} has nothing listening on port ${step.port}, so it refused the connection with a RST out ${shortPortName(step.out)}.`;
    case 'connected':
      return step.path === undefined
        ? `${name} finished the handshake with an ACK out ${shortPortName(step.out)}.`
        : `${name} finished the handshake with an ACK and sent GET ${step.path} out ${shortPortName(step.out)}.`;
    case 'served': {
      const close = step.closing ? ', then closed its side with a FIN' : '';
      return `${name} answered GET ${step.path} with ${step.status} out ${shortPortName(step.out)}${close}.`;
    }
    case 'acked': {
      const out = shortPortName(step.out);
      if (step.response) {
        const close = step.closing ? ' and closed its side with a FIN' : '';
        return `${name} got ${step.response} and acknowledged it${close} out ${out}.`;
      }
      return step.closing
        ? `${name} acknowledged the FIN and closed its side too with a FIN out ${out}.`
        : `${name} acknowledged the FIN out ${out}: the connection is closed.`;
    }
    case 'took':
      switch (step.segment) {
        case 'ack':
          return `${name} took the ACK. An ACK needs no answer.`;
        case 'rst':
          return `${name} took the RST: the other end refused or aborted the connection.`;
        case 'other':
          return `${name} took the segment and sent nothing back.`;
      }
  }
}

function describeIgnore(name: string, reason: IgnoreReason) {
  switch (reason.kind) {
    case 'other-mac':
      return `${name} ignored it: it is addressed to ${reason.dst}, not to ${name}'s MAC.`;
    case 'arp-for-other':
      return `${name} ignored it: the request asks for ${reason.target}, which is not ${name}'s address.`;
    case 'other-ip':
      return `${name} ignored it: it is for ${reason.dst}, and ${name} does not route${isIpv6(reason.dst) ? ' IPv6' : ''}.`;
    case 'other-group':
      return `${name} ignored it: it is for ${reason.group}${GROUP_NAMES[reason.group] ?? ''}, a group ${name} has not joined.`;
    case 'neighbor-for-other':
      return `${name} ignored it: the solicitation asks for ${reason.target}, which is not ${name}'s address.`;
    case 'no-autoconfig':
      return `${name} ignored it: it is not set to autoconfigure IPv6, so it takes no address from router advertisements.`;
    case 'bpdu':
      return `${name} ignored it: only switches run spanning tree.`;
    case 'dhcp-for-other':
      return `${name} ignored it: it is for DHCP client ${reason.client}, not ${name}.`;
    case 'dhcp-not-server':
      return `${name} ignored it: only a DHCP server answers ${DHCP_NAMES[reason.message]}.`;
    case 'no-rip':
      return `${name} ignored it: it is a RIP message, and ${name} does not run RIP.`;
    case 'no-ospf':
      return `${name} ignored it: it is an OSPF packet, and ${name} does not run OSPF.`;
    case 'no-eigrp':
      return `${name} ignored it: it is an EIGRP packet, and ${name} does not run EIGRP.`;
    case 'eigrp-as':
      return `${name} ignored it: it is for EIGRP AS ${reason.asn}, and ${name} runs AS ${reason.own}.`;
    case 'rip-version':
      return `${name} ignored it: it is RIPv${reason.version}, and ${name} is set to RIP version ${reason.accepts} only.`;
  }
}

const GROUP_NAMES: Partial<Record<Ipv6Address, string>> = {
  [ALL_NODES]: ' (all nodes)',
  [ALL_ROUTERS]: ' (all IPv6 routers)',
};

function describeAutoconfigured(
  name: string,
  { router, addresses, gateway }: Extract<Decision, { kind: 'autoconfigured' }>,
) {
  const took = `${name} took the router advertisement from ${router}`;
  if (addresses.length === 0) {
    return gateway
      ? `${took} and uses it as its default gateway. It advertised no prefix to form an address from.`
      : `${took}. It advertised no prefix to form an address from.`;
  }
  const formed = `${took} and gave itself ${addresses.join(' and ')} by SLAAC`;
  return gateway ? `${formed}, with ${router} as its default gateway.` : `${formed}.`;
}

function describeRip(name: string, { command, version, out }: Extract<Decision, { kind: 'rip' }>) {
  const ports = list(out);
  if (command === 'request') {
    return out.length > 0
      ? `${name} read the RIPv${version} request and answered with its table out ${ports}.`
      : `${name} read the RIPv${version} request for its whole table.`;
  }
  return out.length > 0
    ? `${name} read the RIPv${version} update and sent a triggered update out ${ports}.`
    : `${name} read the RIPv${version} update.`;
}

/** What a router read, as in "read the OSPF hello", and what it sent, as in "sent a DBD". */
const OSPF_READ: Record<OspfType, string> = {
  hello: 'hello',
  dbd: 'DBD',
  lsr: 'LS request',
  lsu: 'LS update',
  lsack: 'LS ack',
};
const OSPF_SENT: Record<OspfType, string> = {
  hello: 'a hello',
  dbd: 'a DBD',
  lsr: 'a request',
  lsu: 'an update',
  lsack: 'an ack',
};

function describeOspf(name: string, { type, from, sent }: Extract<Decision, { kind: 'ospf' }>) {
  const read = `${name} read the OSPF ${OSPF_READ[type]} from ${from}`;
  if (sent.length === 0) return `${read}.`;
  const byType = new Map<OspfType, PortId[]>();
  for (const s of sent) byType.set(s.type, [...(byType.get(s.type) ?? []), s.port]);
  const what = [...byType].map(([sentType, ports]) => `${OSPF_SENT[sentType]} out ${list(ports)}`);
  return `${read} and sent ${what.join(' and ')}.`;
}

/** What a router sent, as in "sent an ack". */
const EIGRP_SENT: Record<EigrpType, string> = {
  hello: 'a hello',
  ack: 'an ack',
  update: 'an update',
  query: 'a query',
  reply: 'a reply',
};

function describeEigrp(
  name: string,
  { type, ack, from, sent }: Extract<Decision, { kind: 'eigrp' }>,
) {
  const read =
    type === 'ack'
      ? `${name} read the EIGRP ack from ${from}, which confirms ${name}'s packet ${ack} arrived`
      : `${name} read the EIGRP ${type} from ${from}`;
  if (sent.length === 0) return `${read}.`;
  const byType = new Map<EigrpType, PortId[]>();
  for (const s of sent) byType.set(s.type, [...(byType.get(s.type) ?? []), s.port]);
  const what = [...byType].map(([sentType, ports]) => `${EIGRP_SENT[sentType]} out ${list(ports)}`);
  return `${read} and sent ${what.join(' and ')}.`;
}

/** The decision as one sentence a student can read, with `name` the device's hostname. */
export function describeDecision(decision: Decision, name: string): string {
  switch (decision.kind) {
    case 'lost':
      return `The link was down, so it never reached ${name}.`;
    case 'link-test':
      return `A link test: ${name} only notes that the link works.`;
    case 'spanning-tree':
      return decision.out.length > 0
        ? `${name} fed the BPDU to spanning tree and sent its own BPDU out ${list(decision.out)}.`
        : `${name} fed the BPDU to spanning tree, which uses it to elect the root and choose the ports that forward.`;
    case 'routed': {
      const [counter, [before, after]] =
        'hopLimit' in decision ? ['hop limit', decision.hopLimit] : ['TTL', decision.ttl];
      return `${name} forwarded it out ${shortPortName(decision.out)} and lowered the ${counter} from ${before} to ${after}.`;
    }
    case 'switched':
      return describeSwitched(name, decision.out, decision.retag);
    case 'flooded': {
      const where = decision.vlan === undefined ? '' : ` in VLAN ${decision.vlan}`;
      const why = decision.broadcast
        ? 'a broadcast goes to every port'
        : `${name} has not learned where the destination is, so it tries every port`;
      return `${name} flooded it out ${plural(decision.out.length, 'port')} (${list(decision.out)}): ${why}${where} except the one it came in on.`;
    }
    case 'replied':
      return describeReplied(name, decision);
    case 'resolving': {
      const ask = isIpv6(decision.nextHop) ? 'a neighbor solicitation' : 'an ARP request';
      return decision.forThisDevice
        ? `${name} is the destination. Before it can reply it needs the MAC of ${decision.nextHop}, so it sent ${ask} out ${shortPortName(decision.out)}.`
        : `${name} needs the MAC of next hop ${decision.nextHop}, so it held the packet and sent ${ask} out ${shortPortName(decision.out)}.`;
    }
    case 'learned':
      return decision.released.length > 0
        ? `${name} learned that ${decision.ip} is at ${decision.mac} and sent the waiting packet out ${list(decision.released)}.`
        : `${name} learned that ${decision.ip} is at ${decision.mac} and saved it in its ${isIpv6(decision.ip) ? 'neighbor' : 'ARP'} cache.`;
    case 'autoconfigured':
      return describeAutoconfigured(name, decision);
    case 'received':
      return describeReceived(name, decision);
    case 'dhcp':
      return describeDhcp(name, decision.step);
    case 'web':
      return describeWeb(name, decision.step);
    case 'rip':
      return describeRip(name, decision);
    case 'ospf':
      return describeOspf(name, decision);
    case 'eigrp':
      return describeEigrp(name, decision);
    case 'dropped':
      return describeDrop(name, decision);
    case 'ignored':
      return describeIgnore(name, decision.reason);
    case 'silent':
      return `${name} sent nothing on.`;
  }
}
