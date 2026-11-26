import type { FrameEvent } from '@/engine/events';
import type { Frame } from '@/engine/frame';
import type { ArpPacket, Bpdu, DhcpMessage, IcmpMessage, Ipv4Packet } from '@/engine/pdu';

/** The protocol a frame shows as: the innermost one the engine models. */
export type ProtocolId = 'arp' | 'icmp' | 'dhcp' | 'stp' | 'hello';

/** Each protocol's short label and colour token. The label means colour is never the only cue. */
export const PROTOCOLS: Record<ProtocolId, { label: string; token: `--proto-${string}` }> = {
  arp: { label: 'ARP', token: '--proto-arp' },
  icmp: { label: 'ICMP', token: '--proto-icmp' },
  dhcp: { label: 'DHCP', token: '--proto-dhcp' },
  stp: { label: 'STP', token: '--proto-stp' },
  hello: { label: 'Hello', token: '--proto-stp' },
};

export const PROTOCOL_IDS = Object.keys(PROTOCOLS) as ProtocolId[];

function ipProtocol(packet: Ipv4Packet): ProtocolId {
  switch (packet.payload.kind) {
    case 'icmp':
      return 'icmp';
    case 'udp':
      // DHCP is the one protocol over UDP so far.
      return packet.payload.payload.kind;
  }
}

export function protocolOf(frame: Frame): ProtocolId {
  switch (frame.kind) {
    case 'hello':
      return 'hello';
    case 'hdlc':
      return ipProtocol(frame.payload);
    case 'ethernet':
      switch (frame.payload.kind) {
        case 'arp':
          return 'arp';
        case 'bpdu':
          return 'stp';
        case 'ipv4':
          return ipProtocol(frame.payload);
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
      return `Destination ${message.code} unreachable ${route}`;
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

function describePacket(packet: Ipv4Packet): string {
  const { payload } = packet;
  return payload.kind === 'icmp' ? describeIcmp(packet, payload) : describeDhcp(payload.payload);
}

/** The Info column: what the frame says, in a line a student can read. */
export function describeFrame({ frame, outcome }: Pick<FrameEvent, 'frame' | 'outcome'>): string {
  let text: string;
  switch (frame.kind) {
    case 'hello':
      text = `Link test ${frame.seq}`;
      break;
    case 'hdlc':
      text = describePacket(frame.payload);
      break;
    case 'ethernet': {
      const { payload } = frame;
      const body =
        payload.kind === 'arp'
          ? describeArp(payload)
          : payload.kind === 'bpdu'
            ? describeBpdu(payload)
            : describePacket(payload);
      text = frame.tag ? `${body} · VLAN ${frame.tag.vlan}` : body;
      break;
    }
  }
  return outcome === 'link-down' ? `Lost, link down: ${text}` : text;
}
