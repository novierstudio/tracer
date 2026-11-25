import type { FrameEvent, SentFrame } from '@/engine/events';
import type { Frame } from '@/engine/frame';
import { ingressVlan } from '@/engine/l2/switching';
import { BROADCAST_MAC, type ArpPacket, type Ipv4Packet } from '@/engine/pdu';
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
  | { kind: 'dropped'; reason: DropReason; notified?: PortId }
  | { kind: 'ignored'; reason: IgnoreReason }
  | { kind: 'silent' };

/** How a switch changed a frame's 802.1Q tag on its way out. */
export type Retag =
  { kind: 'same' } | { kind: 'added'; vlan: VlanId } | { kind: 'removed'; vlan: VlanId };

export type DropReason =
  | { kind: 'ttl-expired' }
  | { kind: 'no-route'; dst: Ipv4Address }
  | { kind: 'no-route-back'; dst: Ipv4Address }
  | { kind: 'tagged-on-access' }
  | { kind: 'vlan-not-allowed'; vlan: VlanId }
  | { kind: 'no-port'; vlan: VlanId };

export type IgnoreReason =
  | { kind: 'other-mac'; dst: MacAddress }
  | { kind: 'arp-for-other'; target: Ipv4Address }
  | { kind: 'other-ip'; dst: Ipv4Address }
  | { kind: 'bpdu' }
  | { kind: 'own-mac' };

const ipv4Of = (frame: Frame): Ipv4Packet | undefined =>
  frame.kind === 'hdlc'
    ? frame.payload
    : frame.kind === 'ethernet' && frame.payload.kind === 'ipv4'
      ? frame.payload
      : undefined;

const arpOf = (frame: Frame): ArpPacket | undefined =>
  frame.kind === 'ethernet' && frame.payload.kind === 'arp' ? frame.payload : undefined;

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

function decideIp(device: Device, packet: Ipv4Packet, sent: readonly SentFrame[]): Decision {
  const mine = ownAddresses(device).includes(packet.dst);
  for (const { port, frame } of sent) {
    const next = ipv4Of(frame);
    if (next && isForwardOf(packet, next)) {
      return { kind: 'routed', out: port, ttl: [packet.ttl, next.ttl] };
    }
  }
  for (const { port, frame } of sent) {
    const message = ipv4Of(frame)?.payload;
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
  if (mine) {
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
  if (frame.kind === 'ethernet' && frame.dst !== BROADCAST_MAC && !ownMac(device, frame.dst)) {
    return { kind: 'ignored', reason: { kind: 'other-mac', dst: frame.dst } };
  }
  const arp = arpOf(frame);
  if (arp) return decideArp(device, arp, sent);
  const packet = ipv4Of(frame);
  return packet ? decideIp(device, packet, sent) : { kind: 'silent' };
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
  }
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
    case 'dropped':
      return describeDrop(name, decision);
    case 'ignored':
      return describeIgnore(name, decision.reason);
    case 'silent':
      return `${name} sent nothing on.`;
  }
}
