import { describe, expect, it } from 'vitest';
import type { EventId, FrameEvent } from '@/engine/events';
import {
  ALL_D_ROUTERS,
  ALL_SPF_ROUTERS,
  BROADCAST_MAC,
  multicastMac,
  RIP_GROUP,
  type EthernetFrame,
  type Ipv4Packet,
} from '@/engine/pdu';
import { access, cidr, ip, labBuilder, routedLab, trunk } from '@/engine/testing';
import { ms, simTime } from '@/engine/core/time';
import { createEngine } from '@/engine/engine';
import { createSimService } from '@/engine/service';
import { STACKS } from '@/engine/stacks';
import {
  DhcpServerConfig,
  PortId,
  VirtualInterfaceId,
  type Device,
  type DeviceId,
  type MacAddress,
  type Topology,
} from '@/model';
import {
  ospfAck,
  ospfDbd,
  ospfHello,
  ospfLsr,
  ospfLsu,
  ospfPacket,
  pingFrames,
  ripPacket,
  ripRequest,
  ripV1Response,
  ripV2Response,
} from '../testing';
import { decide, describeDecision, dropLabel } from './decision';

const isBpdu = ({ frame }: FrameEvent) =>
  frame.kind === 'ethernet' && frame.payload.kind === 'bpdu';

function sentences(topology: Topology, frames: FrameEvent[]) {
  return frames.map((event) => {
    const device = topology.devices[event.to.device];
    const decision = decide(event, device);
    return decision && describeDecision(decision, device!.config.hostname);
  });
}

const macOf = (device: Device, port: string) => {
  const found = device.ports.find((candidate) => candidate.id === port);
  return found && found.kind !== 'serial' ? found.mac : undefined;
};

describe('the decision sentence', () => {
  it('tells each hop of a ping across a router', () => {
    const { lab, pc1, pc2, r1 } = routedLab();
    const { topology } = lab;
    const r1Inside = macOf(lab.device(r1), 'GigabitEthernet0/0');
    const pc2Mac = macOf(lab.device(pc2), 'FastEthernet0');

    const frames = pingFrames(topology, pc1, '192.168.2.10').filter((event) => !isBpdu(event));
    expect(sentences(topology, frames)).toEqual([
      'SW1 flooded it out 1 port (Gi0/1): a broadcast goes to every port in VLAN 1 except the one it came in on.',
      'R1 owns the address asked for, so it sent an ARP reply with its MAC out Gi0/0.',
      'SW1 switched it out Fa0/1, toward the destination MAC.',
      `PC1 learned that 192.168.1.1 is at ${r1Inside} and sent the waiting packet out Fa0.`,
      'SW1 switched it out Gi0/1, toward the destination MAC.',
      'R1 needs the MAC of next hop 192.168.2.10, so it held the packet and sent an ARP request out Gi0/1.',
      'SW2 flooded it out 1 port (Fa0/1): a broadcast goes to every port in VLAN 1 except the one it came in on.',
      'PC2 owns the address asked for, so it sent an ARP reply with its MAC out Fa0.',
      'SW2 switched it out Gi0/1, toward the destination MAC.',
      `R1 learned that 192.168.2.10 is at ${pc2Mac} and sent the waiting packet out Gi0/1.`,
      'SW2 switched it out Fa0/1, toward the destination MAC.',
      'PC2 is the destination, so it sent an echo reply back out Fa0.',
      'SW2 switched it out Gi0/1, toward the destination MAC.',
      'R1 forwarded it out Gi0/0 and lowered the TTL from 128 to 127.',
      'SW1 switched it out Fa0/1, toward the destination MAC.',
      'The echo reply reached PC1: the ping succeeded.',
    ]);
  });

  it('tells each hop of a ping a multilayer switch routes between two VLANs', () => {
    const lab = labBuilder();
    const switchports = { 'FastEthernet0/1': access(10), 'FastEthernet0/2': access(20) };
    const mls = lab.switch('MLS', switchports, 'switch-l3-24');
    const pc1 = lab.host('pc', 'PC1', '192.168.10.10/24', '192.168.10.1');
    const pc2 = lab.host('pc', 'PC2', '192.168.20.10/24', '192.168.20.1');
    lab.connect(pc1, 'FastEthernet0', mls, 'FastEthernet0/1');
    lab.connect(pc2, 'FastEthernet0', mls, 'FastEthernet0/2');
    const svi = (address: string) => ({ shutdown: false, ipv4: cidr(address) });
    lab.edit(mls, (device) =>
      device.kind === 'switch'
        ? {
            ...device,
            config: {
              ...device.config,
              ipRouting: true,
              virtualInterfaces: {
                [VirtualInterfaceId.parse('Vlan10')]: svi('192.168.10.1/24'),
                [VirtualInterfaceId.parse('Vlan20')]: svi('192.168.20.1/24'),
              },
            },
          }
        : device,
    );

    const told = sentences(lab.topology, pingFrames(lab.topology, pc1, '192.168.20.10'));
    const byMls = told.filter((sentence) => sentence?.startsWith('MLS'));
    expect(byMls).toEqual([
      'MLS owns the address asked for, so it sent an ARP reply with its MAC out Fa0/1.',
      'MLS needs the MAC of next hop 192.168.20.10, so it held the packet and sent an ARP request out Fa0/2.',
      expect.stringMatching(
        /^MLS learned that 192\.168\.20\.10 is at .+ and sent the waiting packet out Fa0\/2\.$/,
      ),
      'MLS forwarded it out Fa0/1 and lowered the TTL from 128 to 127.',
    ]);
    expect(told.at(-1)).toBe('The echo reply reached PC1: the ping succeeded.');
  });

  it('tells what switches and hosts do with a BPDU', () => {
    const { lab, pc1 } = routedLab();
    const told = sentences(lab.topology, pingFrames(lab.topology, pc1, '192.168.2.10'));
    expect(told).toContain('PC1 ignored it: only switches run spanning tree.');
    expect(told).toContain('R1 ignored it: only switches run spanning tree.');
  });

  it('says why a router dropped a packet it has no route for, and what the sender heard', () => {
    const { lab, pc1 } = routedLab();
    const told = sentences(lab.topology, pingFrames(lab.topology, pc1, '10.9.9.9'));
    expect(told).toContain(
      'R1 has no route to 10.9.9.9, so it dropped the packet and sent Destination Unreachable back out Gi0/0.',
    );
    expect(told.at(-1)).toBe('PC1 heard from 192.168.1.1 that the destination cannot be reached.');
  });

  it('flags drops for the canvas, and leaves forwarding and ignoring alone', () => {
    const { lab, pc1 } = routedLab();
    const frames = pingFrames(lab.topology, pc1, '10.9.9.9');
    const labels = frames.map((event) => dropLabel(decide(event, lab.device(event.to.device))));
    expect(labels.filter(Boolean)).toEqual(['No route']);
    expect(dropLabel({ kind: 'lost' })).toBe('Link down');
  });
});

const mac = (n: number) => `02:00:00:00:00:0${n}` as MacAddress;

function arrival(to: DeviceId, port: string, frame: EthernetFrame, sent: FrameEvent['sent']) {
  return {
    kind: 'frame',
    id: 1 as EventId,
    time: 1,
    sentAt: 0,
    link: 'lnk',
    from: { device: 'dev_x', port: PortId.parse('FastEthernet0') },
    to: { device: to, port: PortId.parse(port) },
    frame,
    outcome: 'delivered',
    sent,
  } as FrameEvent;
}

describe('a decision read from hand-made frames', () => {
  const packet: Ipv4Packet = {
    kind: 'ipv4',
    src: ip('192.168.1.10'),
    dst: ip('192.168.2.10'),
    ttl: 1,
    id: 7,
    payload: { kind: 'icmp', type: 'echo-request', id: 1, seq: 1 },
  };

  it('blames the TTL when a router answers with Time Exceeded', () => {
    const { lab, r1 } = routedLab();
    const router = lab.device(r1);
    const frame: EthernetFrame = {
      kind: 'ethernet',
      src: mac(1),
      dst: macOf(router, 'GigabitEthernet0/0')!,
      payload: packet,
    };
    const timeExceeded: EthernetFrame = {
      kind: 'ethernet',
      src: frame.dst,
      dst: mac(1),
      payload: {
        ...packet,
        src: ip('192.168.1.1'),
        dst: packet.src,
        ttl: 255,
        payload: { kind: 'icmp', type: 'time-exceeded', original: packet },
      },
    };
    const event = arrival(r1, 'GigabitEthernet0/0', frame, [
      { port: PortId.parse('GigabitEthernet0/0'), frame: timeExceeded },
    ]);
    const decision = decide(event, router)!;
    expect(describeDecision(decision, 'R1')).toBe(
      'The TTL ran out at R1, so it dropped the packet and sent Time Exceeded back out Gi0/0.',
    );
    expect(dropLabel(decision)).toBe('TTL expired');
  });

  it('says a switch dropped a tagged frame on an access port, or a VLAN its trunk refuses', () => {
    const lab = labBuilder();
    const sw = lab.switch('SW1', {
      'FastEthernet0/1': access(10),
      'GigabitEthernet0/1': { ...trunk(), allowedVlans: [{ first: 1, last: 5 }] } as never,
    });
    const tagged = (vlan: number): EthernetFrame => ({
      kind: 'ethernet',
      src: mac(1),
      dst: mac(2),
      tag: { vlan: vlan as never },
      payload: packet,
    });
    const onAccess = decide(arrival(sw, 'FastEthernet0/1', tagged(10), []), lab.device(sw))!;
    expect(describeDecision(onAccess, 'SW1')).toBe(
      'SW1 dropped it: a tagged frame arrived on an access port.',
    );
    const onTrunk = decide(arrival(sw, 'GigabitEthernet0/1', tagged(20), []), lab.device(sw))!;
    expect(describeDecision(onTrunk, 'SW1')).toBe(
      'SW1 dropped it: the trunk does not allow VLAN 20.',
    );
    expect(dropLabel(onTrunk)).toBe('VLAN mismatch');
  });

  it('says when a switch tags a frame for a trunk', () => {
    const lab = labBuilder();
    const sw = lab.switch('SW1', { 'FastEthernet0/1': access(10), 'GigabitEthernet0/1': trunk() });
    const frame: EthernetFrame = { kind: 'ethernet', src: mac(1), dst: mac(2), payload: packet };
    const out = { ...frame, tag: { vlan: 10 as never } };
    const event = arrival(sw, 'FastEthernet0/1', frame, [
      { port: PortId.parse('GigabitEthernet0/1'), frame: out },
    ]);
    expect(describeDecision(decide(event, lab.device(sw))!, 'SW1')).toBe(
      'SW1 switched it out trunk Gi0/1 and added an 802.1Q tag for VLAN 10.',
    );
  });

  it('says a host ignored a frame for another MAC', () => {
    const { lab, pc2 } = routedLab();
    const frame: EthernetFrame = { kind: 'ethernet', src: mac(1), dst: mac(9), payload: packet };
    const event = arrival(pc2, 'FastEthernet0', frame, []);
    const decision = decide(event, lab.device(pc2))!;
    expect(describeDecision(decision, 'PC2')).toBe(
      "PC2 ignored it: it is addressed to 02:00:00:00:00:09, not to PC2's MAC.",
    );
    expect(dropLabel(decision)).toBeUndefined();
  });
});

describe('the decision sentence for DHCP', () => {
  /** R1 serving 192.168.1.0/24 to PC1 and PC2 on SW1, and every frame until both have leases. */
  function doraFrames() {
    const lab = labBuilder();
    const r1 = lab.router('R1', { 'GigabitEthernet0/0': '192.168.1.1/24' });
    lab.edit(r1, (device) =>
      device.kind === 'router'
        ? {
            ...device,
            config: {
              ...device.config,
              dhcp: DhcpServerConfig.parse({
                pools: { LAN: { network: { address: '192.168.1.0', prefixLength: 24 } } },
                excluded: [{ first: '192.168.1.1', last: '192.168.1.10' }],
              }),
            },
          }
        : device,
    );
    const sw1 = lab.switch('SW1');
    const pc1 = lab.dhcpHost('pc', 'PC1');
    const pc2 = lab.host('pc', 'PC2', '192.168.1.200/24');
    lab.connect(pc1, 'FastEthernet0', sw1, 'FastEthernet0/1');
    lab.connect(pc2, 'FastEthernet0', sw1, 'FastEthernet0/2');
    lab.connect(sw1, 'GigabitEthernet0/1', r1, 'GigabitEthernet0/0');
    const engine = createEngine({ seed: 1, stacks: STACKS, linkDelay: ms(1) });
    const sim = createSimService({ engine, frames: { now: () => 0, request: () => {} } });
    sim.load(lab.topology);
    engine.runUntil(simTime(20_000));
    const frames = engine.log
      .since(0 as EventId)
      .filter(
        (event): event is FrameEvent =>
          event.kind === 'frame' &&
          event.outcome === 'delivered' &&
          event.frame.kind === 'ethernet' &&
          event.frame.payload.kind === 'ipv4',
      );
    return { lab, frames, pc1Mac: macOf(lab.device(pc1), 'FastEthernet0')! };
  }

  it('tells each step of a DORA, at the server, the client and a bystander', () => {
    const { lab, frames, pc1Mac } = doraFrames();
    const told = sentences(lab.topology, frames);
    expect(told).toEqual(
      expect.arrayContaining([
        "R1's DHCP server offered 192.168.1.11 and sent the Offer out Gi0/0.",
        'PC1 took the offer of 192.168.1.11 and broadcast a Request for it out Fa0.',
        "R1's DHCP server leased 192.168.1.11 to the client and sent an Ack out Gi0/0.",
        'PC1 now has 192.168.1.11: the DHCP server confirmed the lease.',
        'PC2 ignored it: only a DHCP server answers a Discover.',
        `PC2 ignored it: it is for DHCP client ${pc1Mac}, not PC2.`,
      ]),
    );
    // SW1 drops the Discovers that come before spanning tree forwards; R1 answers the rest.
    const drops = frames.map((event) => dropLabel(decide(event, lab.device(event.to.device))));
    expect(new Set(drops.filter(Boolean))).toEqual(new Set(['Nowhere to send']));
  });

  it('marks a Discover a server could not answer as a drop', () => {
    const { lab, frames } = doraFrames();
    const discoverAtR1 = frames.find((event) => {
      const packet = event.frame.kind === 'ethernet' ? event.frame.payload : undefined;
      return (
        packet?.kind === 'ipv4' &&
        packet.payload.kind === 'udp' &&
        packet.payload.payload.kind === 'dhcp' &&
        packet.payload.payload.type === 'discover' &&
        lab.device(event.to.device).kind === 'router'
      );
    })!;
    const unanswered = { ...discoverAtR1, sent: [] };
    const decision = decide(unanswered, lab.device(discoverAtR1.to.device));
    expect(dropLabel(decision)).toBe('No offer');
    expect(describeDecision(decision!, 'R1')).toBe(
      'R1 sent no offer: it has no DHCP pool for this network, or no free address left in it.',
    );
  });
});

describe('a RIP message', () => {
  const { lab, pc2, r1 } = routedLab();
  const plain = lab.device(r1);
  if (plain.kind !== 'router') throw new Error('R1 is not a router');
  const withRip = (version?: 1 | 2): Device => ({
    ...plain,
    config: {
      ...plain.config,
      rip: {
        version,
        networks: [],
        autoSummary: true,
        passiveInterfaces: [],
        defaultOriginate: false,
      },
    },
  });
  const v2Update: EthernetFrame = {
    kind: 'ethernet',
    src: mac(1),
    dst: multicastMac(RIP_GROUP),
    payload: ripPacket(ripV2Response),
  };
  const v1Update: EthernetFrame = {
    kind: 'ethernet',
    src: mac(1),
    dst: BROADCAST_MAC,
    payload: ripPacket(ripV1Response),
  };
  const told = (device: Device, name: string, frame: EthernetFrame, sent: FrameEvent['sent']) => {
    const port = device.kind === 'pc' ? 'FastEthernet0' : 'GigabitEthernet0/1';
    const decision = decide(arrival(device.id, port, frame, sent), device)!;
    return describeDecision(decision, name);
  };
  const ripOut = (port: string, frame: EthernetFrame) => ({ port: PortId.parse(port), frame });

  it('is read by a router running RIP, multicast or broadcast', () => {
    expect(told(withRip(2), 'R2', v2Update, [])).toBe('R2 read the RIPv2 update.');
    expect(told(withRip(), 'R2', v1Update, [])).toBe('R2 read the RIPv1 update.');
    expect(told(withRip(), 'R2', v2Update, [])).toBe('R2 read the RIPv2 update.');
  });

  it('says where a router sent its triggered update, or answered a request with its table', () => {
    expect(
      told(withRip(2), 'R2', v2Update, [
        ripOut('GigabitEthernet0/0', { ...v2Update, src: mac(3) }),
        ripOut('Serial0/0/0', { ...v2Update, src: mac(3) }),
      ]),
    ).toBe('R2 read the RIPv2 update and sent a triggered update out Gi0/0 and Se0/0/0.');
    const request = { ...v2Update, payload: ripPacket(ripRequest(2)) };
    expect(
      told(withRip(2), 'R2', request, [ripOut('GigabitEthernet0/1', { ...v2Update, src: mac(3) })]),
    ).toBe('R2 read the RIPv2 request and answered with its table out Gi0/1.');
    expect(told(withRip(2), 'R2', request, [])).toBe(
      'R2 read the RIPv2 request for its whole table.',
    );
  });

  it('is ignored by a router set to the other version', () => {
    expect(told(withRip(2), 'R2', v1Update, [])).toBe(
      'R2 ignored it: it is RIPv1, and R2 is set to RIP version 2 only.',
    );
    expect(told(withRip(1), 'R2', v2Update, [])).toBe(
      'R2 ignored it: it is RIPv2, and R2 is set to RIP version 1 only.',
    );
  });

  it('is ignored by a PC or a router without RIP, which say they do not run RIP', () => {
    const pc = lab.device(pc2);
    expect(told(pc, 'PC2', v2Update, [])).toBe(
      'PC2 ignored it: it is a RIP message, and PC2 does not run RIP.',
    );
    expect(told(pc, 'PC2', v1Update, [])).toBe(
      'PC2 ignored it: it is a RIP message, and PC2 does not run RIP.',
    );
    const decision = decide(arrival(r1, 'GigabitEthernet0/1', v2Update, []), plain)!;
    expect(describeDecision(decision, 'R1')).toBe(
      'R1 ignored it: it is a RIP message, and R1 does not run RIP.',
    );
    expect(dropLabel(decision)).toBeUndefined();
  });

  it('sent to another MAC is still ignored as another device’s frame', () => {
    expect(told(withRip(2), 'R2', { ...v2Update, dst: mac(9) }, [])).toBe(
      "R2 ignored it: it is addressed to 02:00:00:00:00:09, not to R2's MAC.",
    );
  });
});

describe('an OSPF packet', () => {
  const { lab, pc2, r1 } = routedLab();
  const plain = lab.device(r1);
  if (plain.kind !== 'router') throw new Error('R1 is not a router');
  const withOspf: Device = {
    ...plain,
    config: { ...plain.config, ospf: { processId: 1, networks: [], passiveInterfaces: [] } },
  };
  const toGroup = (packet: Parameters<typeof ospfPacket>[0], group = ALL_SPF_ROUTERS) =>
    ({
      kind: 'ethernet',
      src: mac(1),
      dst: multicastMac(group),
      payload: ospfPacket(packet, group),
    }) satisfies EthernetFrame;
  const hello = toGroup(ospfHello);
  const told = (device: Device, name: string, frame: EthernetFrame, sent: FrameEvent['sent']) => {
    const port = device.kind === 'pc' ? 'FastEthernet0' : 'GigabitEthernet0/1';
    const decision = decide(arrival(device.id, port, frame, sent), device)!;
    return describeDecision(decision, name);
  };
  const out = (port: string, frame: EthernetFrame) => ({ port: PortId.parse(port), frame });

  it('is read by a router running OSPF, sent to either group', () => {
    expect(told(withOspf, 'R2', hello, [])).toBe('R2 read the OSPF hello from 1.1.1.1.');
    expect(told(withOspf, 'R2', toGroup(ospfLsu, ALL_D_ROUTERS), [])).toBe(
      'R2 read the OSPF LS update from 1.1.1.1.',
    );
    expect(told(withOspf, 'R2', toGroup(ospfAck), [])).toBe(
      'R2 read the OSPF LS ack from 2.2.2.2.',
    );
  });

  it('is read when it is sent to the router’s own address and MAC', () => {
    const own = plain.ports.find((port) => port.id === 'GigabitEthernet0/1')!;
    const address = plain.config.interfaces[own.id]!.ipv4!.address;
    const frame: EthernetFrame = {
      kind: 'ethernet',
      src: mac(1),
      dst: own.kind === 'serial' ? mac(9) : own.mac,
      payload: ospfPacket(ospfDbd, address),
    };
    expect(told(withOspf, 'R2', frame, [])).toBe('R2 read the OSPF DBD from 2.2.2.2.');
  });

  it('says what OSPF the router sent back, and out of which ports', () => {
    expect(told(withOspf, 'R2', hello, [out('GigabitEthernet0/1', toGroup(ospfDbd))])).toBe(
      'R2 read the OSPF hello from 1.1.1.1 and sent a DBD out Gi0/1.',
    );
    expect(
      told(withOspf, 'R2', toGroup(ospfLsu), [
        out('GigabitEthernet0/1', toGroup(ospfAck)),
        out('GigabitEthernet0/0', toGroup(ospfLsu)),
        out('Serial0/0/0', toGroup(ospfLsu)),
      ]),
    ).toBe(
      'R2 read the OSPF LS update from 1.1.1.1 and sent an ack out Gi0/1 and an update out Gi0/0 and Se0/0/0.',
    );
    expect(
      told(withOspf, 'R2', toGroup(ospfDbd), [out('GigabitEthernet0/1', toGroup(ospfLsr))]),
    ).toBe('R2 read the OSPF DBD from 2.2.2.2 and sent a request out Gi0/1.');
  });

  it('is ignored by a PC or a router without OSPF, which say they do not run OSPF', () => {
    expect(told(lab.device(pc2), 'PC2', hello, [])).toBe(
      'PC2 ignored it: it is an OSPF packet, and PC2 does not run OSPF.',
    );
    const decision = decide(arrival(r1, 'GigabitEthernet0/1', hello, []), plain)!;
    expect(describeDecision(decision, 'R1')).toBe(
      'R1 ignored it: it is an OSPF packet, and R1 does not run OSPF.',
    );
    expect(dropLabel(decision)).toBeUndefined();
  });

  it('sent to another MAC is still ignored as another device’s frame', () => {
    expect(told(withOspf, 'R2', { ...hello, dst: mac(9) }, [])).toBe(
      "R2 ignored it: it is addressed to 02:00:00:00:00:09, not to R2's MAC.",
    );
  });
});
