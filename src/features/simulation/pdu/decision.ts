import type { FrameEvent, SentFrame } from '@/engine/events';
import type { Frame } from '@/engine/frame';
import { ingressVlan } from '@/engine/l2/switching';
import {
  ALL_D_ROUTERS,
  ALL_SPF_ROUTERS,
  BROADCAST_MAC,
  LIMITED_BROADCAST,
  multicastMac,
  RIP_GROUP,
  type ArpPacket,
  type DhcpMessage,
  type Ipv4Packet,
  type OspfPacket,
  type RipMessage,
  type RipVersion,
} from '@/engine/pdu';
import { shortPortName } from '@/features/canvas/cables';
import type { Device, Ipv4Address, MacAddress, PortId, VlanId } from '@/model';

/**
 * What the receiving device did with a frame, read from the frames it sent while it handled
 * it. A drop is a failure worth a red cross; an ignore is a device minding its own business.
 */
export type Decision =
  | { kind: 'lost' }
  | { kind: 'link-test' }
  | { kind: 'spanning-tree'; out: readonly PortId[] }
  | { kind: 'routed'; out: PortId; ttl: readonly [number, number] }
  | { kind: 'switched'; out: PortId; retag: Retag }
  | { kind: 'flooded'; out: readonly PortId[]; vlan: VlanId | undefined; broadcast: boolean }
  | { kind: 'replied'; reply: 'echo' | 'arp'; out: PortId }
  | { kind: 'resolving'; nextHop: Ipv4Address; out: PortId; forThisDevice: boolean }
  | { kind: 'learned'; ip: Ipv4Address; mac: MacAddress; released: readonly PortId[] }
  | { kind: 'received'; message: 'echo-reply' | 'time-exceeded' | 'unreachable'; from: Ipv4Address }
  | { kind: 'dhcp'; step: DhcpStep }
  /** A router running RIP read a RIP message. `out` are the ports it sent RIP routes out of. */
  | { kind: 'rip'; command: RipMessage['command']; version: RipVersion; out: readonly PortId[] }
  /** A router running OSPF read an OSPF packet. `sent` is the OSPF it sent while it did. */
  | { kind: 'ospf'; type: OspfType; from: Ipv4Address; sent: readonly OspfSent[] }
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

type OspfType = OspfPacket['type'];

/** An OSPF packet a router sent while it handled another, and the port it went out of. */
export type OspfSent = { readonly type: OspfType; readonly port: PortId };

/** How a switch changed a frame's 802.1Q tag on its way out. */
export type Retag =
  { kind: 'same' } | { kind: 'added'; vlan: VlanId } | { kind: 'removed'; vlan: VlanId };

export type DropReason =
  | { kind: 'ttl-expired' }
  | { kind: 'no-route'; dst: Ipv4Address }
  | { kind: 'no-route-back'; dst: Ipv4Address }
  | { kind: 'tagged-on-access' }
  | { kind: 'vlan-not-allowed'; vlan: VlanId }
  | { kind: 'no-port'; vlan: VlanId }
  | { kind: 'no-offer' };

export type IgnoreReason =
  | { kind: 'other-mac'; dst: MacAddress }
  | { kind: 'arp-for-other'; target: Ipv4Address }
  | { kind: 'other-ip'; dst: Ipv4Address }
  | { kind: 'bpdu' }
  | { kind: 'own-mac' }
  | { kind: 'dhcp-for-other'; client: MacAddress }
  | { kind: 'dhcp-not-server'; message: DhcpMessage['type'] }
  | { kind: 'no-rip' }
  | { kind: 'no-ospf' }
  | { kind: 'rip-version'; version: RipVersion; accepts: RipVersion };

const ipv4Of = (frame: Frame): Ipv4Packet | undefined =>
  frame.kind === 'hdlc'
    ? frame.payload
    : frame.kind === 'ethernet' && frame.payload.kind === 'ipv4'
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
    if (ownMac(device, frame.dst)) return { kind: 'ignored', reason: { kind: 'own-mac' } };
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
      return { kind: 'dropped', reason: { kind: 'no-route', dst: packet.dst }, notified: port };
    }
    const arp = arpOf(frame);
    if (arp?.op === 'request') {
      return { kind: 'resolving', nextHop: arp.targetIp, out: port, forThisDevice: mine };
    }
  }
  const message = dhcpOf({ kind: 'hdlc', payload: packet });
  const dhcp = message && decideDhcp(device, packet, message, sent);
  if (dhcp) return dhcp;
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
  if (device.kind === 'router') {
    // A router tells nobody about a lost ICMP error, so errors cannot loop.
    return packet.ttl <= 1
      ? { kind: 'dropped', reason: { kind: 'ttl-expired' } }
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
  if (device.kind === 'switch') return decideSwitch(device, event, sent);
  if (frame.kind === 'ethernet' && frame.payload.kind === 'bpdu') {
    return { kind: 'ignored', reason: { kind: 'bpdu' } };
  }
  const rip = ripFor(device, frame);
  const ospf = ospfFor(device, frame);
  const local =
    frame.kind !== 'ethernet' || frame.dst === BROADCAST_MAC || ownMac(device, frame.dst);
  // Every device sees the RIPv2 and OSPF groups' frames, so it can say whether it runs them.
  if (!local && !(rip && frame.dst === RIP_MAC) && !(ospf && OSPF_MACS.includes(frame.dst))) {
    return { kind: 'ignored', reason: { kind: 'other-mac', dst: frame.dst } };
  }
  if (rip) return decideRip(device, rip, sent);
  if (ospf) return decideOspf(device, ospf, sent);
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
    case 'no-route':
      return 'No route';
    case 'no-route-back':
      return 'No route back';
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

function describeReceived(name: string, decision: Extract<Decision, { kind: 'received' }>) {
  switch (decision.message) {
    case 'echo-reply':
      return `The echo reply reached ${name}: the ping succeeded.`;
    case 'time-exceeded':
      return `${name} heard from ${decision.from} that its packet ran out of TTL on the way.`;
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
    case 'no-route':
      return `${name} has no route to ${reason.dst}, so it dropped the packet${notice('Destination Unreachable')}.`;
    case 'no-route-back':
      return `${name} is the destination but has no route back to ${reason.dst}, so it could not reply.`;
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

function describeIgnore(name: string, reason: IgnoreReason) {
  switch (reason.kind) {
    case 'other-mac':
      return `${name} ignored it: it is addressed to ${reason.dst}, not to ${name}'s MAC.`;
    case 'arp-for-other':
      return `${name} ignored it: the request asks for ${reason.target}, which is not ${name}'s address.`;
    case 'other-ip':
      return `${name} ignored it: it is for ${reason.dst}, and ${name} does not route.`;
    case 'own-mac':
      return `${name} kept it: it is addressed to ${name} itself.`;
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
    case 'rip-version':
      return `${name} ignored it: it is RIPv${reason.version}, and ${name} is set to RIP version ${reason.accepts} only.`;
  }
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
    case 'routed':
      return `${name} forwarded it out ${shortPortName(decision.out)} and lowered the TTL from ${decision.ttl[0]} to ${decision.ttl[1]}.`;
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
      return decision.reply === 'echo'
        ? `${name} is the destination, so it sent an echo reply back out ${shortPortName(decision.out)}.`
        : `${name} owns the address asked for, so it sent an ARP reply with its MAC out ${shortPortName(decision.out)}.`;
    case 'resolving':
      return decision.forThisDevice
        ? `${name} is the destination. Before it can reply it needs the MAC of ${decision.nextHop}, so it sent an ARP request out ${shortPortName(decision.out)}.`
        : `${name} needs the MAC of next hop ${decision.nextHop}, so it held the packet and sent an ARP request out ${shortPortName(decision.out)}.`;
    case 'learned':
      return decision.released.length > 0
        ? `${name} learned that ${decision.ip} is at ${decision.mac} and sent the waiting packet out ${list(decision.released)}.`
        : `${name} learned that ${decision.ip} is at ${decision.mac} and saved it in its ARP cache.`;
    case 'received':
      return describeReceived(name, decision);
    case 'dhcp':
      return describeDhcp(name, decision.step);
    case 'rip':
      return describeRip(name, decision);
    case 'ospf':
      return describeOspf(name, decision);
    case 'dropped':
      return describeDrop(name, decision);
    case 'ignored':
      return describeIgnore(name, decision.reason);
    case 'silent':
      return `${name} sent nothing on.`;
  }
}
