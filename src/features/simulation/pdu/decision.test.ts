import { describe, expect, it } from 'vitest';
import type { EventId, FrameEvent } from '@/engine/events';
import type { Frame } from '@/engine/frame';
import type { Ipv6Packet } from '@/engine/pdu6';
import {
  ALL_D_ROUTERS,
  ALL_SPF_ROUTERS,
  BROADCAST_MAC,
  EIGRP_GROUP,
  CDP_MAC,
  LLDP_MAC,
  multicastMac,
  RIP_GROUP,
  SLOW_PROTOCOLS_MAC,
  type EthernetFrame,
  type EthernetPayload,
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
  eui64Address,
  ipv6MulticastMac,
  solicitedNode,
  UNSPECIFIED_IPV6,
  type Ipv6Address,
} from '@/model/ipv6';
import {
  cdpAdvertisement,
  dnsAnswer,
  dnsNoSuchName,
  dnsQuery,
  echoRequest6,
  eigrpAck,
  eigrpHello,
  eigrpPacket,
  eigrpQuery,
  eigrpUpdate,
  lacpPdu,
  lldpAdvertisement,
  neighborAdvertisement,
  neighborSolicitation,
  ospfAck,
  ospfDbd,
  ospfHello,
  ospfLsr,
  ospfLsu,
  ospfPacket,
  pagpPdu,
  PC1_IPV6,
  pingFrames,
  R1_IPV6,
  R1_LINK_LOCAL,
  R1_MAC,
  ripPacket,
  ripRequest,
  ripV1Response,
  ripV2Response,
  routerAdvertisement,
  routerSolicitation,
  tcpRefusal,
  webPacket,
  webSession,
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

  it('says an access list denied a packet, and marks the drop for the canvas', () => {
    const { lab, pc1, r1 } = routedLab();
    lab.edit(r1, (device) => {
      if (device.kind !== 'router') return device;
      const inside = device.config.interfaces['GigabitEthernet0/0' as PortId]!;
      const noPing = {
        type: 'extended' as const,
        entries: [
          {
            kind: 'rule' as const,
            action: 'deny' as const,
            protocol: 'icmp' as const,
            source: { address: ip('0.0.0.0'), wildcard: ip('255.255.255.255') },
            destination: { address: ip('0.0.0.0'), wildcard: ip('255.255.255.255') },
          },
        ],
      };
      return {
        ...device,
        config: {
          ...device.config,
          accessLists: { '101': noPing },
          interfaces: {
            ...device.config.interfaces,
            ['GigabitEthernet0/0' as PortId]: { ...inside, accessGroupIn: '101' },
          },
        },
      };
    });
    const frames = pingFrames(lab.topology, pc1, '192.168.2.10');

    expect(sentences(lab.topology, frames)).toContain(
      'An access list on R1 denied the packet, so it dropped it and sent Destination Unreachable (administratively prohibited) back out Gi0/0.',
    );
    const labels = frames.map((event) => dropLabel(decide(event, lab.device(event.to.device))));
    expect(labels.filter(Boolean)).toEqual(['ACL deny']);
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

describe('a CDP, LLDP, LACP or PAgP frame', () => {
  const DST: Record<string, MacAddress> = {
    cdp: CDP_MAC,
    lldp: LLDP_MAC,
    lacp: SLOW_PROTOCOLS_MAC,
    pagp: CDP_MAC,
  };

  /** What `device` says it did with `payload` on `port`. */
  function told(
    lab: ReturnType<typeof routedLab>['lab'],
    device: DeviceId,
    port: string,
    payload: EthernetPayload,
  ) {
    const frame: EthernetFrame = {
      kind: 'ethernet',
      dst: DST[payload.kind]!,
      src: mac(9),
      payload,
    };
    const target = lab.device(device);
    return describeDecision(
      decide(arrival(device, port, frame, []), target)!,
      target.config.hostname,
    );
  }

  it('is read by a router or switch running CDP, and ignored by a host', () => {
    const { lab, pc1, r1, sw1 } = routedLab();
    const fromR1 = { ...cdpAdvertisement, deviceId: 'R1', portId: 'GigabitEthernet0/0' };
    expect(told(lab, sw1, 'GigabitEthernet0/1', fromR1)).toBe(
      'SW1 read the CDP advertisement on Gi0/1 and keeps R1 as a neighbour for 180 s.',
    );
    expect(told(lab, r1, 'GigabitEthernet0/0', cdpAdvertisement)).toBe(
      'R1 read the CDP advertisement on Gi0/0 and keeps SW1 as a neighbour for 180 s.',
    );
    expect(told(lab, pc1, 'FastEthernet0', cdpAdvertisement)).toBe(
      'PC1 ignored it: hosts do not run CDP.',
    );
  });

  it('is ignored where CDP is off, for the device or the port', () => {
    const { lab, r1, sw1 } = routedLab();
    lab.edit(r1, (device) =>
      device.kind === 'router'
        ? { ...device, config: { ...device.config, cdpRun: false } }
        : device,
    );
    lab.edit(sw1, (device) => {
      if (device.kind !== 'switch') return device;
      const port = PortId.parse('GigabitEthernet0/1');
      const iface = device.config.interfaces[port]!;
      const interfaces = { ...device.config.interfaces, [port]: { ...iface, cdpEnable: false } };
      return { ...device, config: { ...device.config, interfaces } };
    });
    expect(told(lab, r1, 'GigabitEthernet0/0', cdpAdvertisement)).toBe(
      'R1 ignored it: R1 does not run CDP on Gi0/0.',
    );
    expect(told(lab, sw1, 'GigabitEthernet0/1', cdpAdvertisement)).toBe(
      'SW1 ignored it: SW1 does not run CDP on Gi0/1.',
    );
  });

  it('is read only by a device set to lldp run', () => {
    const { lab, pc1, r1 } = routedLab();
    const fromSw2 = { ...lldpAdvertisement, systemName: 'SW2', portId: 'GigabitEthernet0/1' };
    expect(told(lab, r1, 'GigabitEthernet0/1', fromSw2)).toBe(
      'R1 ignored it: R1 does not run LLDP on Gi0/1.',
    );
    lab.edit(r1, (device) =>
      device.kind === 'router'
        ? { ...device, config: { ...device.config, lldpRun: true } }
        : device,
    );
    expect(told(lab, r1, 'GigabitEthernet0/1', fromSw2)).toBe(
      'R1 read the LLDP advertisement on Gi0/1 and keeps SW2 as a neighbour for 120 s.',
    );
    expect(told(lab, pc1, 'FastEthernet0', lldpAdvertisement)).toBe(
      'PC1 ignored it: hosts do not run LLDP.',
    );
  });

  it('is read by a port in a channel group of its protocol, and ignored elsewhere', () => {
    const { lab, pc1, r1, sw1 } = routedLab();
    lab.edit(sw1, (device) => {
      if (device.kind !== 'switch') return device;
      const port = PortId.parse('FastEthernet0/2');
      const iface = device.config.interfaces[port]!;
      const channelGroup = { group: 1, mode: 'active' as const };
      const interfaces = { ...device.config.interfaces, [port]: { ...iface, channelGroup } };
      return { ...device, config: { ...device.config, interfaces } };
    });
    expect(told(lab, sw1, 'FastEthernet0/2', lacpPdu)).toBe(
      'SW1 read the LACP packet on Fa0/2 and uses it to bundle the port into Port-channel1.',
    );
    expect(told(lab, sw1, 'FastEthernet0/2', pagpPdu)).toBe(
      'SW1 ignored it: Fa0/2 is in no PAgP channel group.',
    );
    expect(told(lab, sw1, 'FastEthernet0/3', lacpPdu)).toBe(
      'SW1 ignored it: Fa0/3 is in no LACP channel group.',
    );
    expect(told(lab, r1, 'GigabitEthernet0/0', pagpPdu)).toBe(
      'R1 ignored it: Gi0/0 is in no PAgP channel group.',
    );
    expect(told(lab, pc1, 'FastEthernet0', lacpPdu)).toBe('PC1 ignored it: hosts do not run LACP.');
    expect(told(lab, pc1, 'FastEthernet0', pagpPdu)).toBe('PC1 ignored it: hosts do not run PAgP.');
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

describe('an EIGRP packet', () => {
  const { lab, pc2, r1 } = routedLab();
  const plain = lab.device(r1);
  if (plain.kind !== 'router') throw new Error('R1 is not a router');
  const inAs = (asn: number): Device => ({
    ...plain,
    config: {
      ...plain.config,
      eigrp: { asn, networks: [], passiveInterfaces: [], variance: 1 },
    },
  });
  const toGroup = (packet: Parameters<typeof eigrpPacket>[0]) =>
    ({
      kind: 'ethernet',
      src: mac(1),
      dst: multicastMac(EIGRP_GROUP),
      payload: eigrpPacket(packet),
    }) satisfies EthernetFrame;
  const hello = toGroup(eigrpHello);
  const told = (device: Device, name: string, frame: EthernetFrame, sent: FrameEvent['sent']) => {
    const port = device.kind === 'pc' ? 'FastEthernet0' : 'GigabitEthernet0/1';
    const decision = decide(arrival(device.id, port, frame, sent), device)!;
    return describeDecision(decision, name);
  };
  const out = (port: string, frame: EthernetFrame) => ({ port: PortId.parse(port), frame });
  /** A packet to R1's own address on Gi0/1 and that port's MAC, as an ack is sent. */
  const unicast = (packet: Parameters<typeof eigrpPacket>[0]): EthernetFrame => {
    const own = plain.ports.find((port) => port.id === 'GigabitEthernet0/1')!;
    return {
      kind: 'ethernet',
      src: mac(1),
      dst: own.kind === 'serial' ? mac(9) : own.mac,
      payload: eigrpPacket(packet, plain.config.interfaces[own.id]!.ipv4!.address),
    };
  };

  it('is read by a router in the same AS, sent to the group', () => {
    expect(told(inAs(1), 'R2', hello, [])).toBe('R2 read the EIGRP hello from 10.0.12.1.');
    expect(told(inAs(1), 'R2', toGroup(eigrpQuery), [])).toBe(
      'R2 read the EIGRP query from 10.0.12.1.',
    );
  });

  it('reads an ack sent to the router’s own address and MAC, and says which packet it confirms', () => {
    expect(told(inAs(1), 'R2', unicast(eigrpAck), [])).toBe(
      "R2 read the EIGRP ack from 10.0.12.1, which confirms R2's packet 5 arrived.",
    );
  });

  it('says what EIGRP the router sent back, and out of which ports', () => {
    expect(
      told(inAs(1), 'R2', toGroup(eigrpUpdate), [
        out('GigabitEthernet0/1', unicast(eigrpAck)),
        out('GigabitEthernet0/0', toGroup(eigrpUpdate)),
        out('Serial0/0/0', toGroup(eigrpUpdate)),
      ]),
    ).toBe(
      'R2 read the EIGRP update from 10.0.12.1 and sent an ack out Gi0/1 and an update out Gi0/0 and Se0/0/0.',
    );
    expect(
      told(inAs(1), 'R2', toGroup(eigrpQuery), [
        out('GigabitEthernet0/1', unicast({ ...eigrpQuery, opcode: 'reply' })),
      ]),
    ).toBe('R2 read the EIGRP query from 10.0.12.1 and sent a reply out Gi0/1.');
  });

  it('is ignored by a router in another AS, which says both numbers', () => {
    const decision = decide(arrival(r1, 'GigabitEthernet0/1', hello, []), inAs(2))!;
    expect(describeDecision(decision, 'R2')).toBe(
      'R2 ignored it: it is for EIGRP AS 1, and R2 runs AS 2.',
    );
    expect(dropLabel(decision)).toBeUndefined();
  });

  it('is ignored by a PC or a router without EIGRP, which say they do not run EIGRP', () => {
    expect(told(lab.device(pc2), 'PC2', hello, [])).toBe(
      'PC2 ignored it: it is an EIGRP packet, and PC2 does not run EIGRP.',
    );
    expect(told(plain, 'R1', hello, [])).toBe(
      'R1 ignored it: it is an EIGRP packet, and R1 does not run EIGRP.',
    );
  });

  it('sent to another MAC is still ignored as another device’s frame', () => {
    expect(told(inAs(1), 'R2', { ...hello, dst: mac(9) }, [])).toBe(
      "R2 ignored it: it is addressed to 02:00:00:00:00:09, not to R2's MAC.",
    );
  });
});

describe('fetching a web page', () => {
  const { lab, pc1, pc2 } = routedLab();
  const port = PortId.parse('FastEthernet0');
  type Payload = Parameters<typeof webPacket>[0];

  /** `payload` arriving at PC1 (the client) or PC2 (the server), which sent `replies` back. */
  function sentence(to: DeviceId, packet: Ipv4Packet, replies: Payload[] = []) {
    const device = lab.device(to);
    const frame: EthernetFrame = {
      kind: 'ethernet',
      src: mac(9),
      dst: macOf(device, 'FastEthernet0')!,
      payload: packet,
    };
    const sent = replies.map((reply) => ({
      port,
      frame: { kind: 'ethernet', src: frame.dst, dst: mac(9), payload: webPacket(reply) } as const,
    }));
    const decision = decide(arrival(to, 'FastEthernet0', frame, sent), device)!;
    expect(dropLabel(decision)).toBeUndefined();
    return describeDecision(decision, device.config.hostname);
  }
  const at = (to: DeviceId, payload: Payload, replies?: Payload[]) =>
    sentence(to, webPacket(payload), replies);
  const s = webSession;

  it('tells what the server and the client did with each of the nine segments', () => {
    expect([
      at(pc2, s[0]!, [s[1]!]),
      at(pc1, s[1]!, [s[2]!, s[3]!]),
      at(pc2, s[2]!),
      at(pc2, s[3]!, [s[4]!, s[5]!]),
      at(pc1, s[4]!, [s[6]!]),
      at(pc1, s[5]!, [s[7]!]),
      at(pc2, s[6]!),
      at(pc2, s[7]!, [s[8]!]),
      at(pc1, s[8]!),
    ]).toEqual([
      'PC2 is listening on port 80, so it answered the SYN with a SYN+ACK out Fa0.',
      'PC1 finished the handshake with an ACK and sent GET / out Fa0.',
      'PC2 took the ACK. An ACK needs no answer.',
      'PC2 answered GET / with 200 OK out Fa0, then closed its side with a FIN.',
      'PC1 got 200 OK and acknowledged it out Fa0.',
      'PC1 acknowledged the FIN and closed its side too with a FIN out Fa0.',
      'PC2 took the ACK. An ACK needs no answer.',
      'PC2 acknowledged the FIN out Fa0: the connection is closed.',
      'PC1 took the ACK. An ACK needs no answer.',
    ]);
  });

  it('says a server refused a SYN to a port nothing listens on, and the client took the RST', () => {
    const syn = { ...s[0]!, dstPort: 8080 };
    const toServer = { ...webPacket(s[0]!), payload: syn };
    const rst = tcpRefusal(syn);
    expect(sentence(pc2, toServer, [rst])).toBe(
      'PC2 has nothing listening on port 8080, so it refused the connection with a RST out Fa0.',
    );
    expect(sentence(pc1, { ...webPacket(s[1]!), payload: rst })).toBe(
      'PC1 took the RST: the other end refused or aborted the connection.',
    );
  });

  it('tells the DNS lookup at the server and the client, found or not', () => {
    expect(at(pc2, dnsQuery, [dnsAnswer])).toBe(
      'PC2 looked up www.lab.local and sent back its address, 192.168.2.10, out Fa0.',
    );
    expect(at(pc1, dnsAnswer, [s[0]!])).toBe(
      'PC1 learned that www.lab.local is at 192.168.2.10 and opened a TCP connection to it with a SYN out Fa0.',
    );
    const missing = { ...dnsQuery, id: dnsNoSuchName.id, name: dnsNoSuchName.name };
    expect(at(pc2, missing, [dnsNoSuchName])).toBe(
      'PC2 knows no host named www.x.local, so it answered that there is no such name out Fa0.',
    );
    expect(at(pc1, dnsNoSuchName)).toBe(
      'PC1 heard that no host is named www.x.local, so it cannot connect.',
    );
    // A host that runs no DNS server lets a query for it go unanswered.
    expect(sentence(pc1, { ...webPacket(dnsQuery), dst: ip('192.168.1.10') })).toBe(
      'PC1 sent nothing on.',
    );
  });

  it('still says a host ignored a segment for another address', () => {
    const elsewhere = { ...webPacket(s[0]!), dst: ip('192.168.2.99') };
    expect(sentence(pc2, elsewhere)).toBe(
      'PC2 ignored it: it is for 192.168.2.99, and PC2 does not route.',
    );
  });
});

describe('an IPv6 frame', () => {
  const v6 = (text: string) => text as Ipv6Address;
  const routed = routedLab();
  const { lab, pc1, pc2, r1 } = routed;
  const cidr6 = (address: string) => ({ address: v6(address), prefixLength: 64 });
  /** R1 routes IPv6 with 2001:db8:1::1 and fe80::1 on Gi0/0; PC1 autoconfigures; PC2 is static. */
  lab.edit(r1, (device) =>
    device.kind === 'router'
      ? {
          ...device,
          config: {
            ...device.config,
            ipv6UnicastRouting: true,
            interfaces: {
              ...device.config.interfaces,
              [PortId.parse('GigabitEthernet0/0')]: {
                ...device.config.interfaces[PortId.parse('GigabitEthernet0/0')]!,
                ipv6: {
                  linkLocal: R1_LINK_LOCAL,
                  addresses: [{ cidr: cidr6('2001:db8:1::1'), eui64: false }],
                },
              },
            },
          },
        }
      : device,
  );
  lab.edit(pc1, (device) =>
    device.kind === 'pc'
      ? { ...device, config: { ...device.config, ipv6: { mode: 'auto' } } }
      : device,
  );
  lab.edit(pc2, (device) =>
    device.kind === 'pc'
      ? {
          ...device,
          config: {
            ...device.config,
            ipv6: { mode: 'static', address: cidr6('2001:db8:2::10'), gateway: v6('fe80::1') },
          },
        }
      : device,
  );
  const router = lab.device(r1);
  const pc1Mac = macOf(lab.device(pc1), 'FastEthernet0')!;
  const pc2Mac = macOf(lab.device(pc2), 'FastEthernet0')!;
  const r1Mac = macOf(router, 'GigabitEthernet0/0')!;
  const gi0 = PortId.parse('GigabitEthernet0/0');
  const gi1 = PortId.parse('GigabitEthernet0/1');
  const fa0 = PortId.parse('FastEthernet0');

  /** `packet` in an Ethernet frame to `dst`: a device's MAC, or the MAC of the group it is sent to. */
  const frame = (packet: Ipv6Packet, dst?: MacAddress): EthernetFrame => ({
    kind: 'ethernet',
    src: mac(9),
    dst: dst ?? ipv6MulticastMac(packet.dst),
    payload: packet,
  });
  const out = (port: PortId, packet: Ipv6Packet, dst: MacAddress = mac(9)) => ({
    port,
    frame: frame(packet, dst),
  });
  function told(to: DeviceId, port: string, arrived: Frame, sent: FrameEvent['sent'] = []) {
    const device = lab.device(to);
    const event = { ...arrival(to, port, arrived as EthernetFrame, sent), frame: arrived };
    const decision = decide(event, device)!;
    return { sentence: describeDecision(decision, device.config.hostname), decision };
  }
  const sentence = (...args: Parameters<typeof told>) => told(...args).sentence;
  const icmp = (payload: Ipv6Packet['payload'], src = R1_IPV6, dst = PC1_IPV6): Ipv6Packet => ({
    kind: 'ipv6',
    src,
    dst,
    hopLimit: 64,
    payload,
  });

  it('tells each step of a ping across R1, with the hop limit it lowered', () => {
    const atR1 = frame(echoRequest6, r1Mac);
    const forwarded = { ...echoRequest6, hopLimit: 127 };
    const solicit: Ipv6Packet = {
      ...neighborSolicitation,
      src: v6('fe80::1'),
      dst: solicitedNode(forwarded.dst),
      payload: { kind: 'icmpv6', type: 'neighbor-solicitation', target: forwarded.dst },
    };
    const reply = icmp({ kind: 'icmpv6', type: 'echo-reply', id: 1, seq: 1 }, forwarded.dst);
    expect([
      sentence(r1, 'GigabitEthernet0/0', atR1, [out(gi1, forwarded)]),
      sentence(r1, 'GigabitEthernet0/0', atR1, [out(gi1, solicit, ipv6MulticastMac(solicit.dst))]),
      sentence(pc2, 'FastEthernet0', frame(forwarded, pc2Mac), [out(fa0, reply)]),
      sentence(pc1, 'FastEthernet0', frame(reply, pc1Mac)),
    ]).toEqual([
      'R1 forwarded it out Gi0/1 and lowered the hop limit from 128 to 127.',
      'R1 needs the MAC of next hop 2001:db8:2::10, so it held the packet and sent a neighbor solicitation out Gi0/1.',
      'PC2 is the destination, so it sent an echo reply back out Fa0.',
      'The echo reply reached PC1: the ping succeeded.',
    ]);
  });

  it('says R1 dropped a packet whose hop limit ran out, or that it has no route for', () => {
    const lastHop = frame({ ...echoRequest6, hopLimit: 1 }, r1Mac);
    const exceeded = icmp({ kind: 'icmpv6', type: 'time-exceeded', original: echoRequest6 });
    const expired = told(r1, 'GigabitEthernet0/0', lastHop, [out(gi0, exceeded)]);
    expect(expired.sentence).toBe(
      'The hop limit ran out at R1, so it dropped the packet and sent Time Exceeded back out Gi0/0.',
    );
    expect(dropLabel(expired.decision)).toBe('Hop limit expired');

    const nowhere = { ...echoRequest6, dst: v6('2001:db8:9::1') };
    const unreachable = (code: 'no-route' | 'address-unreachable') =>
      icmp({ kind: 'icmpv6', type: 'destination-unreachable', code, original: nowhere });
    const noRoute = told(r1, 'GigabitEthernet0/0', frame(nowhere, r1Mac), [
      out(gi0, unreachable('no-route')),
    ]);
    expect(noRoute.sentence).toBe(
      'R1 has no route to 2001:db8:9::1, so it dropped the packet and sent Destination Unreachable back out Gi0/0.',
    );
    expect(dropLabel(noRoute.decision)).toBe('No route');
    const unanswered = told(r1, 'GigabitEthernet0/0', frame(nowhere, r1Mac), [
      out(gi0, unreachable('address-unreachable')),
    ]);
    expect(unanswered.sentence).toBe(
      "Nothing on R1's link answered for 2001:db8:9::1, so it dropped the packet and sent Destination Unreachable (address unreachable) back out Gi0/0.",
    );
    // A router tells nobody about an ICMPv6 error it cannot deliver.
    expect(sentence(r1, 'GigabitEthernet0/0', lastHop)).toBe(
      'The hop limit ran out at R1, so it dropped the packet.',
    );
  });

  it('says what the sender heard from the router', () => {
    const original = { ...echoRequest6, hopLimit: 1 };
    const exceeded = icmp({ kind: 'icmpv6', type: 'time-exceeded', original });
    const unreachable = icmp({
      kind: 'icmpv6',
      type: 'destination-unreachable',
      code: 'no-route',
      original,
    });
    expect(sentence(pc1, 'FastEthernet0', frame(exceeded, pc1Mac))).toBe(
      'PC1 heard from 2001:db8:1::1 that its packet ran out of hop limit on the way.',
    );
    expect(sentence(pc1, 'FastEthernet0', frame(unreachable, pc1Mac))).toBe(
      'PC1 heard from 2001:db8:1::1 that the destination cannot be reached.',
    );
  });

  it('answers a neighbor solicitation for its own address, and ignores the rest', () => {
    const toGroup = frame(neighborSolicitation);
    const advert = { ...neighborAdvertisement, dst: neighborSolicitation.src };
    expect(sentence(r1, 'GigabitEthernet0/0', toGroup, [out(gi0, advert)])).toBe(
      'R1 owns the address asked for, so it sent a neighbor advertisement with its MAC out Gi0/0.',
    );
    expect(sentence(pc2, 'FastEthernet0', toGroup)).toBe(
      'PC2 ignored it: it is for ff02::1:ff00:1, a group PC2 has not joined.',
    );
    // 2001:db8:5::1 shares its last 24 bits, and so its group, with R1's address.
    const other: Ipv6Packet = {
      ...neighborSolicitation,
      payload: { kind: 'icmpv6', type: 'neighbor-solicitation', target: v6('2001:db8:5::1') },
    };
    expect(sentence(r1, 'GigabitEthernet0/0', frame(other))).toBe(
      "R1 ignored it: the solicitation asks for 2001:db8:5::1, which is not R1's address.",
    );
  });

  it('learns the MAC a neighbor advertisement carries and sends what waited for it', () => {
    const advert = frame(neighborAdvertisement, pc1Mac);
    expect(sentence(pc1, 'FastEthernet0', advert, [out(fa0, echoRequest6, r1Mac)])).toBe(
      `PC1 learned that 2001:db8:1::1 is at ${R1_MAC} and sent the waiting packet out Fa0.`,
    );
    expect(sentence(pc1, 'FastEthernet0', advert)).toBe(
      `PC1 learned that 2001:db8:1::1 is at ${R1_MAC} and saved it in its neighbor cache.`,
    );
  });

  it('has a router answer a router solicitation, which hosts do not listen for', () => {
    const solicit = frame(routerSolicitation);
    expect(sentence(r1, 'GigabitEthernet0/0', solicit, [out(gi0, routerAdvertisement)])).toBe(
      'R1 routes IPv6, so it answered with a router advertisement out Gi0/0.',
    );
    expect(sentence(pc2, 'FastEthernet0', solicit)).toBe(
      'PC2 ignored it: it is for ff02::2 (all IPv6 routers), a group PC2 has not joined.',
    );
  });

  it('has a host set to autoconfigure take a router advertisement, and a static host ignore it', () => {
    const advert = frame(routerAdvertisement);
    const slaac = eui64Address(v6('2001:db8:1::'), pc1Mac);
    expect(sentence(pc1, 'FastEthernet0', advert)).toBe(
      `PC1 took the router advertisement from fe80::1 and gave itself ${slaac} by SLAAC, with fe80::1 as its default gateway.`,
    );
    // The address it checks for duplicates is the one it formed.
    const checked = v6('2001:db8:1::abcd');
    const probe: Ipv6Packet = {
      ...neighborSolicitation,
      src: UNSPECIFIED_IPV6,
      dst: solicitedNode(checked),
      payload: { kind: 'icmpv6', type: 'neighbor-solicitation', target: checked },
    };
    expect(sentence(pc1, 'FastEthernet0', advert, [out(fa0, probe)])).toBe(
      'PC1 took the router advertisement from fe80::1 and gave itself 2001:db8:1::abcd by SLAAC, with fe80::1 as its default gateway.',
    );
    const leaving = { ...routerAdvertisement.payload, routerLifetime: 0, prefixes: [] };
    expect(
      sentence(pc1, 'FastEthernet0', frame({ ...routerAdvertisement, payload: leaving })),
    ).toBe(
      'PC1 took the router advertisement from fe80::1. It advertised no prefix to form an address from.',
    );
    expect(sentence(pc2, 'FastEthernet0', advert)).toBe(
      'PC2 ignored it: it is not set to autoconfigure IPv6, so it takes no address from router advertisements.',
    );
  });

  it('ignores a frame for another MAC, and a packet a router that does not route IPv6 is sent', () => {
    expect(sentence(pc2, 'FastEthernet0', frame(echoRequest6, mac(7)))).toBe(
      "PC2 ignored it: it is addressed to 02:00:00:00:00:07, not to PC2's MAC.",
    );
    const plain = routedLab();
    const plainMac = macOf(plain.lab.device(plain.r1), 'GigabitEthernet0/0')!;
    const event = arrival(plain.r1, 'GigabitEthernet0/0', frame(echoRequest6, plainMac), []);
    expect(describeDecision(decide(event, plain.lab.device(plain.r1))!, 'R1')).toBe(
      'R1 ignored it: it is for 2001:db8:2::10, and R1 does not route IPv6.',
    );
  });

  it('says a host cannot answer a ping it has no route back for', () => {
    expect(sentence(pc2, 'FastEthernet0', frame(echoRequest6, pc2Mac))).toBe(
      'PC2 is the destination but has no route back to 2001:db8:1::10, so it could not reply.',
    );
  });

  it('reads IPv6 on a serial link, where there is no MAC to match', () => {
    const serial: Frame = { kind: 'hdlc', payload: echoRequest6 };
    expect(
      sentence(r1, 'Serial0/0/0', serial, [
        { port: gi1, frame: frame({ ...echoRequest6, hopLimit: 127 }, mac(8)) },
      ]),
    ).toBe('R1 forwarded it out Gi0/1 and lowered the hop limit from 128 to 127.');
  });
});
