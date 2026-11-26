import { describe, expect, it } from 'vitest';
import {
  CHANNEL_MODES,
  PortId,
  VlanId,
  type ChannelMode,
  type Device,
  type DeviceId,
  type Link,
  type LoadBalance,
} from '@/model';
import type { PingEvent } from '../api';
import { after, ms } from '../core/time';
import { createEngine } from '../engine';
import type { FrameEvent } from '../events';
import { createSimService } from '../service';
import { STACKS } from '../stacks';
import { access, ip, labBuilder, STP_CONVERGED } from '../testing';
import { bundleCost, loadBalanceHash } from './etherchannel';

const FA1 = PortId.parse('FastEthernet0/1');
const FA2 = PortId.parse('FastEthernet0/2');

type Edit = (device: Extract<Device, { kind: 'switch' }>) => void;

const editSwitch =
  (edit: Edit) =>
  (device: Device): Device => {
    if (device.kind !== 'switch') throw new Error('not a switch');
    const copy = structuredClone(device);
    edit(copy);
    return copy;
  };

const channel =
  (mode: ChannelMode, group = 1): Edit =>
  (device) => {
    for (const port of [FA1, FA2]) device.config.interfaces[port]!.channelGroup = { group, mode };
  };

/**
 * SW1 and SW2 cabled twice, Fa0/1 to Fa0/1 and Fa0/2 to Fa0/2, with PC1 on SW1 Fa0/5 and PC2 on
 * SW2 Fa0/5. `sw1` and `sw2` edit each switch before the lab loads.
 */
function pair(sw1Edit: Edit, sw2Edit: Edit) {
  const lab = labBuilder();
  const sw1 = lab.switch('SW1');
  const sw2 = lab.switch('SW2');
  const pc1 = lab.host('pc', 'PC1', '10.0.0.1/24');
  const pc2 = lab.host('pc', 'PC2', '10.0.0.2/24');
  lab.connect(sw1, 'FastEthernet0/1', sw2, 'FastEthernet0/1');
  lab.connect(sw1, 'FastEthernet0/2', sw2, 'FastEthernet0/2');
  lab.connect(pc1, 'FastEthernet0', sw1, 'FastEthernet0/5');
  lab.connect(pc2, 'FastEthernet0', sw2, 'FastEthernet0/5');
  lab.edit(sw1, editSwitch(sw1Edit));
  lab.edit(sw2, editSwitch(sw2Edit));
  const topology = lab.topology;

  const engine = createEngine({ seed: 1, stacks: STACKS, linkDelay: ms(1) });
  const sim = createSimService({ engine, frames: { now: () => 0, request: () => {} } });
  sim.load(topology);
  const runFor = (millis: number) => engine.runUntil(after(engine.now, ms(millis)));

  const status = (id: DeviceId) => {
    const result = sim.layer2Status(id);
    if (!result.ok) throw new Error(result.error);
    return result.value;
  };
  /** Each member of SW's group 1 as `FastEthernet0/1(P)`. */
  const members = (id: DeviceId) =>
    status(id).etherchannels.flatMap((group) =>
      group.members.map((member) => `${member.port}(${member.flag})`),
    );
  const link = (port: PortId): Link =>
    Object.values(topology.links).find(
      (candidate) => candidate.a.device === sw1 && candidate.a.port === port,
    )!;
  const ping = (count = 4) => {
    const events: PingEvent[] = [];
    const started = sim.ping(pc1, ip('10.0.0.2'), { count, timeoutMs: 1000 }, (event) =>
      events.push(event),
    );
    if (!started.ok) throw new Error(started.error);
    while (!events.some((event) => event.kind === 'summary')) engine.step();
    return events;
  };
  return { engine, sim, topology, sw1, sw2, pc1, pc2, runFor, status, members, link, ping };
}

/** Whether two modes facing each other bundle, as IOS negotiates them. */
const BUNDLES: Record<ChannelMode, readonly ChannelMode[]> = {
  on: ['on'],
  active: ['active', 'passive'],
  passive: ['active'],
  desirable: ['desirable', 'auto'],
  auto: ['desirable'],
};

describe('EtherChannel negotiation', () => {
  const pairs = CHANNEL_MODES.flatMap((a) => CHANNEL_MODES.map((b) => [a, b] as const));

  it.each(pairs)('%s facing %s bundles only as IOS does', (a, b) => {
    const lab = pair(channel(a), channel(b));
    lab.runFor(1000);
    const bundles = BUNDLES[a].includes(b);
    const expected = (mode: ChannelMode) =>
      // Mode on bundles whatever is at the far end; the negotiating side stands alone.
      bundles || mode === 'on' ? 'P' : 'I';
    expect(lab.members(lab.sw1)).toEqual([`${FA1}(${expected(a)})`, `${FA2}(${expected(a)})`]);
    expect(lab.members(lab.sw2)).toEqual([`${FA1}(${expected(b)})`, `${FA2}(${expected(b)})`]);
    const group = lab.status(lab.sw1).etherchannels[0]!;
    expect(group.inUse).toBe(expected(a) === 'P');
    expect(group.protocol).toBe(
      a === 'on' ? undefined : a === 'active' || a === 'passive' ? 'lacp' : 'pagp',
    );
  });

  it('suspends a member whose VLAN differs from the bundle', () => {
    const lab = pair((device) => {
      channel('active')(device);
      device.config.interfaces[FA2]!.switchport = access(10);
      device.config.vlans[VlanId.parse(10)] = { name: 'VLAN0010' };
    }, channel('active'));
    lab.runFor(1000);
    expect(lab.members(lab.sw1)).toEqual([`${FA1}(P)`, `${FA2}(s)`]);
  });

  it('suspends a member whose speed differs from the first member', () => {
    const lab = pair((device) => {
      channel('on')(device);
      device.config.interfaces[FA2]!.speed = 10;
    }, channel('on'));
    lab.runFor(1000);
    expect(lab.members(lab.sw1)).toEqual([`${FA1}(P)`, `${FA2}(s)`]);
  });

  it('logs the port-channel coming up on the console', () => {
    const lab = pair(channel('on'), channel('on'));
    const syslog = lab.engine.log
      .since(0 as never)
      .filter((event) => event.kind === 'syslog' && event.device === lab.sw1)
      .map((event) => (event.kind === 'syslog' ? event.text : ''));
    expect(syslog).toContain('%LINK-3-UPDOWN: Interface Port-channel1, changed state to up');
    expect(syslog).toContain(
      '%LINEPROTO-5-UPDOWN: Line protocol on Interface Port-channel1, changed state to up',
    );
  });
});

describe('EtherChannel and the bridge', () => {
  it('spanning tree sees the bundle as one port, with the cost of its bandwidth', () => {
    const lab = pair(channel('active'), channel('passive'));
    lab.runFor(STP_CONVERGED + 1000);
    const result = lab.sim.spanningTree(lab.sw1);
    if (!result.ok) throw new Error(result.error);
    const ports = result.value[0]!.ports.map(
      ({ port, id, cost, state }) => `${port} ${id.priority}.${id.number} ${cost} ${state}`,
    );
    // The test switch has 10 ports, so Po1 is port 11. Two 100 Mbit/s members cost 12.
    expect(ports).toEqual([
      'FastEthernet0/5 128.5 19 forwarding',
      'Port-channel1 128.11 12 forwarding',
    ]);
  });

  it('without a channel, spanning tree blocks one of the two links', () => {
    const lab = pair(
      () => {},
      () => {},
    );
    lab.runFor(STP_CONVERGED + 1000);
    const states = [lab.sw1, lab.sw2].flatMap((id) => {
      const result = lab.sim.spanningTree(id);
      if (!result.ok) throw new Error(result.error);
      return result.value[0]!.ports.map((port) => port.state);
    });
    expect(states.filter((state) => state === 'blocking')).toHaveLength(1);
  });

  it('learns addresses on the port-channel', () => {
    const lab = pair(channel('desirable'), channel('auto'));
    lab.runFor(STP_CONVERGED + 1000);
    expect(lab.ping(1).at(-1)).toMatchObject({ kind: 'summary', received: 1 });
    const table = lab.sim.macTable(lab.sw1);
    if (!table.ok) throw new Error(table.error);
    const pc2Mac = lab.topology.devices[lab.pc2]!.ports[0]!;
    if (pc2Mac.kind === 'serial') throw new Error('serial');
    expect(table.value.find((entry) => entry.mac === pc2Mac.mac)?.port).toBe('Port-channel1');
  });

  it('keeps traffic flowing when one member is unplugged', () => {
    const lab = pair(channel('active'), channel('active'));
    lab.runFor(STP_CONVERGED + 1000);
    expect(lab.ping(2).at(-1)).toMatchObject({ kind: 'summary', received: 2 });

    // Pull whichever member PC1's frames leave by, so the bundle must move them to the other.
    for (const port of [FA1, FA2]) {
      const before = lab.engine.log.lastId;
      lab.ping(1);
      const used = lab.engine.log
        .since(before)
        .some(
          (event): event is FrameEvent =>
            event.kind === 'frame' && event.from.device === lab.sw1 && event.from.port === port,
        );
      if (!used) continue;
      lab.engine.applyPatch({ devices: {}, links: { [lab.link(port).id]: null } });
      break;
    }
    expect(lab.members(lab.sw1).filter((member) => member.endsWith('(P)'))).toHaveLength(1);
    // Spanning tree does not start over: the port-channel stays up and forwarding throughout.
    expect(lab.ping(4).at(-1)).toMatchObject({ kind: 'summary', received: 4 });
  });

  it('a lone member keeps the bundle, and losing it takes the port-channel down', () => {
    const lab = pair(channel('on'), channel('on'));
    lab.runFor(STP_CONVERGED);
    lab.engine.applyPatch({ devices: {}, links: { [lab.link(FA1).id]: null } });
    expect(lab.status(lab.sw1).etherchannels[0]!.inUse).toBe(true);
    lab.engine.applyPatch({ devices: {}, links: { [lab.link(FA2).id]: null } });
    expect(lab.status(lab.sw1).etherchannels[0]!.inUse).toBe(false);
    expect(lab.members(lab.sw1)).toEqual([`${FA1}(D)`, `${FA2}(D)`]);
  });
});

describe('load balancing', () => {
  const frame = (src: string, dst: string) => ({
    kind: 'ethernet' as const,
    src: src as never,
    dst: dst as never,
    payload: {
      kind: 'ipv4' as const,
      src: ip('10.0.0.5'),
      dst: ip('10.0.0.6'),
      ttl: 64,
      id: 1,
      payload: { kind: 'icmp', type: 'echo-request', id: 1, seq: 1 } as never,
    },
  });

  it.each([
    ['src-mac', 0x01],
    ['dst-mac', 0x02],
    ['src-dst-mac', 0x03],
    ['src-ip', 5],
    ['dst-ip', 6],
    ['src-dst-ip', 3],
  ] as [LoadBalance, number][])('%s hashes the low bits of its addresses', (method, hash) => {
    expect(loadBalanceHash(method, frame('00:00:00:00:00:01', '00:00:00:00:00:02'))).toBe(hash);
  });

  it('costs a bundle by its bandwidth, as IOS short costs do', () => {
    expect([100, 200, 300, 400, 800, 1000, 2000, 4000].map(bundleCost)).toEqual([
      19, 12, 9, 8, 7, 4, 3, 3,
    ]);
  });
});
