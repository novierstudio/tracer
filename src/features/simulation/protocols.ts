import type { FrameEvent } from '@/engine/events';
import type { Frame } from '@/engine/frame';
import type {
  ArpPacket,
  Bpdu,
  CdpPacket,
  DhcpMessage,
  EigrpPacket,
  EthernetPayload,
  IcmpMessage,
  Ipv4Packet,
  LacpPdu,
  LldpPacket,
  OspfPacket,
  PagpPdu,
  RipMessage,
  UdpDatagram,
  VtpPdu,
} from '@/engine/pdu';
import { isNdp, type Ipv6Packet } from '@/engine/pdu6';
import type { TcpSegment } from '@/engine/tcp';
import { shortPortName } from '@/features/canvas/cables';
import type { PortId } from '@/model';
import { formatIpv6Cidr, UNSPECIFIED_IPV6 } from '@/model/ipv6';
import type { ControlPdu } from './pdu/control';
import { describeDns, describePayload, describeTcp } from './pdu/web';

/** The protocol a frame shows as: the innermost one the engine models. */
export type ProtocolId =
  | 'arp'
  | 'icmp'
  | 'icmpv6'
  | 'ndp'
  | 'dhcp'
  | 'dns'
  | 'tcp'
  | 'http'
  | 'telnet'
  | 'ssh'
  | 'rip'
  | 'ospf'
  | 'eigrp'
  | 'stp'
  | 'cdp'
  | 'lldp'
  | 'lacp'
  | 'pagp'
  | 'vtp'
  | 'hsrp'
  | 'hello';

/** Each protocol's short label and colour token. The label means colour is never the only cue. */
export const PROTOCOLS: Record<ProtocolId, { label: string; token: `--proto-${string}` }> = {
  arp: { label: 'ARP', token: '--proto-arp' },
  icmp: { label: 'ICMP', token: '--proto-icmp' },
  icmpv6: { label: 'ICMPv6', token: '--proto-icmp' },
  // Neighbor Discovery is IPv6's ARP, so it shares ARP's colour.
  ndp: { label: 'NDP', token: '--proto-arp' },
  dhcp: { label: 'DHCP', token: '--proto-dhcp' },
  dns: { label: 'DNS', token: '--proto-dns' },
  tcp: { label: 'TCP', token: '--proto-tcp' },
  http: { label: 'HTTP', token: '--proto-tcp' },
  telnet: { label: 'Telnet', token: '--proto-tcp' },
  ssh: { label: 'SSH', token: '--proto-tcp' },
  rip: { label: 'RIP', token: '--proto-routing' },
  ospf: { label: 'OSPF', token: '--proto-routing' },
  eigrp: { label: 'EIGRP', token: '--proto-routing' },
  stp: { label: 'STP', token: '--proto-stp' },
  // Discovery and EtherChannel talk only to the next device, as spanning tree does, so share its colour.
  cdp: { label: 'CDP', token: '--proto-stp' },
  lldp: { label: 'LLDP', token: '--proto-stp' },
  lacp: { label: 'LACP', token: '--proto-stp' },
  pagp: { label: 'PAgP', token: '--proto-stp' },
  vtp: { label: 'VTP', token: '--proto-stp' },
  // HSRP keeps a LAN's gateway up, so it shares the routing protocols' colour.
  hsrp: { label: 'HSRP', token: '--proto-routing' },
  hello: { label: 'Hello', token: '--proto-stp' },
};

export const PROTOCOL_IDS = Object.keys(PROTOCOLS) as ProtocolId[];

function ipProtocol(packet: Ipv4Packet): ProtocolId {
  switch (packet.payload.kind) {
    case 'icmp':
      return 'icmp';
    case 'udp':
      // Each protocol over UDP is a protocol of its own.
      return packet.payload.payload.kind;
    case 'ospf':
      return 'ospf';
    case 'eigrp':
      return 'eigrp';
    case 'tcp':
      // A segment that carries data shows as its application; a bare SYN, ACK, FIN or RST as TCP.
      return packet.payload.payload?.kind ?? 'tcp';
  }
}

/** ICMPv6 is the only payload IPv6 carries here. Neighbor Discovery shows as a protocol of its own. */
const ipv6Protocol = (packet: Ipv6Packet): ProtocolId => (isNdp(packet.payload) ? 'ndp' : 'icmpv6');

export function protocolOf(frame: Frame): ProtocolId {
  switch (frame.kind) {
    case 'hello':
      return 'hello';
    case 'hdlc':
      if (frame.payload.kind === 'cdp') return 'cdp';
      return frame.payload.kind === 'ipv6'
        ? ipv6Protocol(frame.payload)
        : ipProtocol(frame.payload);
    case 'ethernet':
      switch (frame.payload.kind) {
        case 'arp':
          return 'arp';
        case 'bpdu':
          return 'stp';
        case 'ipv4':
          return ipProtocol(frame.payload);
        case 'ipv6':
          return ipv6Protocol(frame.payload);
        case 'cdp':
        case 'lldp':
        case 'lacp':
        case 'pagp':
        case 'vtp':
          return frame.payload.kind;
      }
  }
}

/** The payloads one device sends its neighbour on each port, which no device passes on. */
export type LinkControl = Bpdu | ControlPdu;

const LINK_CONTROL: ReadonlySet<EthernetPayload['kind']> = new Set<LinkControl['kind']>([
  'bpdu',
  'cdp',
  'lldp',
  'lacp',
  'pagp',
  'vtp',
]);

export const isLinkControl = (payload: EthernetPayload): payload is LinkControl =>
  LINK_CONTROL.has(payload.kind);

/** Frames whose protocol is not hidden, in their original order. */
export function visibleFrames(
  frames: readonly FrameEvent[],
  hidden: readonly ProtocolId[],
): readonly FrameEvent[] {
  if (hidden.length === 0) return frames;
  return frames.filter((event) => !hidden.includes(protocolOf(event.frame)));
}

function describeArp(arp: ArpPacket): string {
  return arp.op === 'request'
    ? `Who has ${arp.targetIp}? Tell ${arp.senderIp}`
    : `${arp.senderIp} is at ${arp.senderMac}`;
}

function describeIcmp(packet: Ipv4Packet, message: IcmpMessage): string {
  const route = `${packet.src} → ${packet.dst}`;
  switch (message.type) {
    case 'echo-request':
      return `Echo request ${route}, seq ${message.seq}, TTL ${packet.ttl}`;
    case 'echo-reply':
      return `Echo reply ${route}, seq ${message.seq}, TTL ${packet.ttl}`;
    case 'destination-unreachable':
      return message.code === 'admin-prohibited'
        ? `Destination unreachable, administratively prohibited ${route}`
        : `Destination ${message.code} unreachable ${route}`;
    case 'time-exceeded':
      return `TTL expired in transit ${route}`;
  }
}

function describeBpdu(bpdu: Bpdu): string {
  if (bpdu.type === 'tcn') return 'Topology change notification';
  const flags = [
    ...(bpdu.topologyChange ? ['topology change'] : []),
    ...(bpdu.topologyChangeAck ? ['TC ack'] : []),
  ];
  const { root, bridge, port } = bpdu;
  const text = `Root ${root.priority} ${root.mac}, cost ${bpdu.rootPathCost}, from ${bridge.priority} ${bridge.mac} port ${port.priority}.${port.number}`;
  return flags.length > 0 ? `${text} · ${flags.join(', ')}` : text;
}

const portName = (id: string) => shortPortName(id as PortId);

const describeCdp = (cdp: CdpPacket) =>
  `CDP from ${cdp.deviceId} ${portName(cdp.portId)} (holdtime ${cdp.holdtime})`;

const describeLldp = (lldp: LldpPacket) =>
  `LLDP from ${lldp.systemName} ${portName(lldp.portId)} (TTL ${lldp.ttl})`;

function describeLacp({ actor, partner }: LacpPdu): string {
  const heard = partner ? `partner ${partner.system} port ${partner.port}` : 'no partner yet';
  return `LACP from ${actor.system} port ${actor.port}: ${actor.active ? 'active' : 'passive'}, ${heard}`;
}

function describePagp(pagp: PagpPdu): string {
  const heard = pagp.partner
    ? `partner ${pagp.partner.device} port ${pagp.partner.port}`
    : 'no partner yet';
  return `PAgP from ${pagp.device} port ${pagp.port}: ${pagp.desirable ? 'desirable' : 'auto'}, group ${pagp.group}, ${heard}`;
}

function describeVtp(vtp: VtpPdu): string {
  switch (vtp.code) {
    case 'summary':
      return `VTP summary, domain ${vtp.domain}, revision ${vtp.revision}`;
    case 'subset':
      return `VTP subset, domain ${vtp.domain}, revision ${vtp.revision}, ${count(vtp.vlans.length, 'VLAN')}`;
    case 'request':
      return `VTP request, domain ${vtp.domain}`;
  }
}

function describeEthernetPayload(payload: EthernetPayload): string {
  switch (payload.kind) {
    case 'arp':
      return describeArp(payload);
    case 'bpdu':
      return describeBpdu(payload);
    case 'ipv4':
      return describePacket(payload);
    case 'ipv6':
      return describeIpv6(payload);
    case 'cdp':
      return describeCdp(payload);
    case 'lldp':
      return describeLldp(payload);
    case 'lacp':
      return describeLacp(payload);
    case 'pagp':
      return describePagp(payload);
    case 'vtp':
      return describeVtp(payload);
  }
}

function describeDhcp(message: DhcpMessage): string {
  const relayed = message.giaddr === '0.0.0.0' ? '' : ` via relay ${message.giaddr}`;
  switch (message.type) {
    case 'discover':
      return `DHCP Discover from ${message.chaddr}${relayed}`;
    case 'offer':
      return `DHCP Offer ${message.yiaddr} to ${message.chaddr}${relayed}`;
    case 'request':
      return `DHCP Request for ${message.requestedIp ?? message.ciaddr} from ${message.chaddr}${relayed}`;
    case 'ack':
      return `DHCP Ack ${message.yiaddr} to ${message.chaddr}${relayed}`;
    case 'nak':
      return `DHCP Nak to ${message.chaddr}${relayed}`;
    case 'release':
      return `DHCP Release of ${message.ciaddr} from ${message.chaddr}`;
  }
}

function describeRip(packet: Ipv4Packet, message: RipMessage): string {
  if (message.command === 'request') return `RIPv${message.version} request for the whole table`;
  const routes = message.entries.length;
  return `RIPv${message.version} response, ${routes} route${routes === 1 ? '' : 's'} ${packet.src} → ${packet.dst}`;
}

const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function describeOspf(packet: OspfPacket): string {
  switch (packet.type) {
    case 'hello':
      return packet.dr === '0.0.0.0'
        ? `OSPF hello from ${packet.routerId}`
        : `OSPF hello from ${packet.routerId}, DR ${packet.dr}`;
    case 'dbd': {
      const roles = [...(packet.init ? ['init'] : []), packet.master ? 'master' : 'slave'];
      return `OSPF DBD from ${packet.routerId}, ${count(packet.headers.length, 'LSA header')} (${roles.join(', ')})`;
    }
    case 'lsr':
      return `OSPF LS request, ${count(packet.requests.length, 'LSA')}`;
    case 'lsu':
      return `OSPF LS update from ${packet.routerId}, ${count(packet.lsas.length, 'LSA')}`;
    case 'lsack':
      return `OSPF LS ack, ${count(packet.headers.length, 'LSA')}`;
  }
}

function describeEigrp(packet: EigrpPacket): string {
  if (packet.opcode === 'hello') {
    return packet.parameters ? `EIGRP hello, AS ${packet.asn}` : `EIGRP ack ${packet.ack}`;
  }
  const text = `EIGRP ${packet.opcode}, ${count(packet.routes.length, 'route')}`;
  return packet.init ? `${text} (init)` : text;
}

function describeUdp(packet: Ipv4Packet, datagram: UdpDatagram): string {
  switch (datagram.payload.kind) {
    case 'dhcp':
      return describeDhcp(datagram.payload);
    case 'rip':
      return describeRip(packet, datagram.payload);
    case 'dns':
      return `DNS ${describeDns(datagram.payload)}`;
    case 'hsrp': {
      const { opcode, group, state, priority } = datagram.payload;
      return `HSRP ${opcode} from ${packet.src}, group ${group}, ${state}, priority ${priority}`;
    }
  }
}

const describeSegment = (segment: TcpSegment) =>
  segment.payload ? describePayload(segment.payload) : `TCP ${describeTcp(segment)}`;

function describePacket(packet: Ipv4Packet): string {
  const { payload } = packet;
  switch (payload.kind) {
    case 'icmp':
      return describeIcmp(packet, payload);
    case 'udp':
      return describeUdp(packet, payload);
    case 'ospf':
      return describeOspf(payload);
    case 'eigrp':
      return describeEigrp(payload);
    case 'tcp':
      return describeSegment(payload);
  }
}

function describeIpv6(packet: Ipv6Packet): string {
  const message = packet.payload;
  const route = `${packet.src} → ${packet.dst}`;
  switch (message.type) {
    case 'echo-request':
      return `Echo request ${route}, seq ${message.seq}, hop limit ${packet.hopLimit}`;
    case 'echo-reply':
      return `Echo reply ${route}, seq ${message.seq}, hop limit ${packet.hopLimit}`;
    case 'destination-unreachable':
      return `Destination unreachable (${message.code === 'no-route' ? 'no route' : 'address unreachable'}) ${route}`;
    case 'time-exceeded':
      return `Hop limit exceeded in transit ${route}`;
    case 'neighbor-solicitation':
      return packet.src === UNSPECIFIED_IPV6
        ? `Neighbor solicitation: is ${message.target} in use? (duplicate address check)`
        : `Neighbor solicitation: who has ${message.target}? Tell ${packet.src}`;
    case 'neighbor-advertisement':
      return `Neighbor advertisement: ${message.target} is at ${message.targetMac}${message.router ? ' (router)' : ''}`;
    case 'router-solicitation':
      return `Router solicitation from ${packet.src}`;
    case 'router-advertisement': {
      const prefixes = message.prefixes.map((info) => formatIpv6Cidr(info.prefix));
      return prefixes.length > 0
        ? `Router advertisement from ${packet.src}: prefix ${prefixes.join(', ')}`
        : `Router advertisement from ${packet.src}, no prefix`;
    }
  }
}

/** The Info column: what the frame says, in a line a student can read. */
export function describeFrame({ frame, outcome }: Pick<FrameEvent, 'frame' | 'outcome'>): string {
  let text: string;
  switch (frame.kind) {
    case 'hello':
      text = `Link test ${frame.seq}`;
      break;
    case 'hdlc':
      text =
        frame.payload.kind === 'cdp'
          ? describeEthernetPayload(frame.payload)
          : frame.payload.kind === 'ipv6'
            ? describeIpv6(frame.payload)
            : describePacket(frame.payload);
      break;
    case 'ethernet': {
      const body = describeEthernetPayload(frame.payload);
      text = frame.tag ? `${body} · VLAN ${frame.tag.vlan}` : body;
      break;
    }
  }
  return outcome === 'link-down' ? `Lost, link down: ${text}` : text;
}
