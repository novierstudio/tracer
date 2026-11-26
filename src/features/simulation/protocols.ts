import type { FrameEvent } from '@/engine/events';
import type { Frame } from '@/engine/frame';
import type {
  ArpPacket,
  Bpdu,
  DhcpMessage,
  IcmpMessage,
  Ipv4Packet,
  OspfPacket,
  RipMessage,
  UdpDatagram,
} from '@/engine/pdu';
import { isNdp, type Ipv6Packet } from '@/engine/pdu6';
import type { TcpSegment } from '@/engine/tcp';
import { formatIpv6Cidr, UNSPECIFIED_IPV6 } from '@/model/ipv6';
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
  | 'stp'
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
  stp: { label: 'STP', token: '--proto-stp' },
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
      }
  }
}

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

function describeUdp(packet: Ipv4Packet, datagram: UdpDatagram): string {
  switch (datagram.payload.kind) {
    case 'dhcp':
      return describeDhcp(datagram.payload);
    case 'rip':
      return describeRip(packet, datagram.payload);
    case 'dns':
      return `DNS ${describeDns(datagram.payload)}`;
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
        frame.payload.kind === 'ipv6' ? describeIpv6(frame.payload) : describePacket(frame.payload);
      break;
    case 'ethernet': {
      const { payload } = frame;
      const body =
        payload.kind === 'arp'
          ? describeArp(payload)
          : payload.kind === 'bpdu'
            ? describeBpdu(payload)
            : payload.kind === 'ipv6'
              ? describeIpv6(payload)
              : describePacket(payload);
      text = frame.tag ? `${body} · VLAN ${frame.tag.vlan}` : body;
      break;
    }
  }
  return outcome === 'link-down' ? `Lost, link down: ${text}` : text;
}
