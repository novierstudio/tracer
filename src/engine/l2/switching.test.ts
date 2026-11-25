import { describe, expect, it } from 'vitest';
import { PortId, type DeviceId, type MacAddress, type SwitchInterface } from '@/model';
import { ms, simTime } from '../core/time';
import { createEngine } from '../engine';
import type { SimEvent } from '../events';
import type { SimModule } from '../module';
import { BROADCAST_MAC, type EthernetFrame } from '../pdu';
import { createSimService } from '../service';
import { access, ip, labBuilder, stacksOf, STP_CONVERGED, trunk } from '../testing';
import { switchingModule } from './switching';

/** A host that sends what a test tells it to and runs no protocol. */
const nic: SimModule<null> = { id: 'nic', init: () => null };

const FA0 = PortId.parse('FastEthernet0');

function frameTo(src: MacAddress, dst: MacAddress): EthernetFrame {
  const address = ip('10.0.0.1');
  return {
    kind: 'ethernet',
    dst,
    src,
    payload: {
      kind: 'arp',
      op: 'reply',
      senderMac: src,
      senderIp: address,
      targetMac: dst,
      targetIp: address,
    },
  };
}

/**
 * PC1, PC2 and PC3 on SW1's Fa0/1 to Fa0/3, and PC4 on SW2's Fa0/1. SW2 hangs off SW1's Gi0/1
 * only when `uplink` gives both ends' switchport.
 */
function switchedLab({
  switchports = {},
  uplink,
  sw2Port = access(1),
}: {
  switchports?: Record<string, SwitchInterface['switchport']>;
  uplink?: SwitchInterface['switchport'];
  sw2Port?: SwitchInterface['switchport'];
} = {}) {
  const lab = labBuilder();
  const sw1 = lab.switch('SW1', {
    ...switchports,
    ...(uplink && { 'GigabitEthernet0/1': uplink }),
  });
  const pcs = [1, 2, 3].map((n) => {
    const pc = lab.host('pc', `PC${n}`);
    lab.connect(pc, 'FastEthernet0', sw1, `FastEthernet0/${n}`);
    return pc;
  });
  let pc4: DeviceId | undefined;
  if (uplink) {
    const sw2 = lab.switch('SW2', { 'GigabitEthernet0/1': uplink, 'FastEthernet0/1': sw2Port });
    lab.connect(sw1, 'GigabitEthernet0/1', sw2, 'GigabitEthernet0/1');
    pc4 = lab.host('pc', 'PC4');
    lab.connect(pc4, 'FastEthernet0', sw2, 'FastEthernet0/1');
  }

  const engine = createEngine({
    seed: 1,
    stacks: stacksOf({ switch: [switchingModule], pc: [nic] }),
    linkDelay: ms(1),
  });
  const sim = createSimService({ engine, frames: { now: () => 0, request: () => {} } });
  sim.load(lab.topology);
  engine.runUntil(STP_CONVERGED);

  const name = (id: DeviceId) => lab.device(id).config.hostname;
  const mac = (id: DeviceId): MacAddress => {
    const port = lab.device(id).ports[0]!;
    if (port.kind === 'serial') throw new Error('no MAC on a serial port');
    return port.mac;
  };
  /** Sends one frame from a host and returns every hop it made, as "from > to". */
  const send = (from: DeviceId, dst: MacAddress | DeviceId) => {
    const frame = frameTo(
      mac(from),
      dst.includes(':') ? (dst as MacAddress) : mac(dst as DeviceId),
    );
    engine.withModule(from, nic, (ctx) => ctx.send(FA0, frame));
    return hops(engine.runUntil(simTime(engine.now + 10)));
  };
  /** Data frames only: spanning tree's BPDUs come and go on their own clock. */
  const hops = (events: SimEvent[]) =>
    events.flatMap((event) =>
      event.kind === 'frame' &&
      event.outcome === 'delivered' &&
      !(event.frame.kind === 'ethernet' && event.frame.payload.kind === 'bpdu')
        ? [`${name(event.from.device)} > ${name(event.to.device)}`]
        : [],
    );
  const table = (id: DeviceId) => {
    const result = sim.macTable(id);
    if (!result.ok) throw new Error(result.error);
    return result.value.map(({ vlan, mac: address, port }) => [vlan, address, port]);
  };

  const [pc1, pc2, pc3] = pcs as [DeviceId, DeviceId, DeviceId];
  return { lab, engine, sim, sw1, pc1, pc2, pc3, pc4, mac, send, table };
}

describe('the switch', () => {
  it('floods a frame for an unknown address out every other port, never the one it came in on', () => {
    const { pc1, pc2, send } = switchedLab();

    expect(send(pc1, pc2)).toEqual(['PC1 > SW1', 'SW1 > PC2', 'SW1 > PC3']);
  });

  it('learns each sender, so a frame for a known address goes out its one port', () => {
    const { sw1, pc1, pc2, mac, send, table } = switchedLab();
    send(pc1, pc2);

    expect(send(pc2, pc1)).toEqual(['PC2 > SW1', 'SW1 > PC1']);
    expect(table(sw1)).toEqual(
      [
        [1, mac(pc1), 'FastEthernet0/1'],
        [1, mac(pc2), 'FastEthernet0/2'],
      ].sort((a, b) => String(a[1]).localeCompare(String(b[1]))),
    );
  });

  it('floods a broadcast even when it knows every address', () => {
    const { pc1, pc2, pc3, send } = switchedLab();
    send(pc1, pc2);
    send(pc2, pc3);
    send(pc3, pc1);

    expect(send(pc1, BROADCAST_MAC)).toEqual(['PC1 > SW1', 'SW1 > PC2', 'SW1 > PC3']);
  });

  it('drops a frame whose destination sits behind the port it came in on', () => {
    const { pc1, pc2, send } = switchedLab();
    send(pc1, pc2);

    expect(send(pc1, pc1)).toEqual(['PC1 > SW1']);
  });

  it('forgets an address 300 s after it last heard from it, then floods again', () => {
    const { engine, sw1, pc1, pc2, mac, send, table } = switchedLab();
    // Past the topology change the ports raised by forwarding, which lasts max age plus forward
    // delay and ages addresses after forward delay meanwhile.
    engine.runUntil(simTime(STP_CONVERGED + 10_000));
    send(pc1, pc2);
    const learnedAt = STP_CONVERGED + 10_001;

    engine.runUntil(simTime(learnedAt + 299_999));
    expect(table(sw1).map(([, address]) => address)).toContain(mac(pc1));

    engine.runUntil(simTime(learnedAt + 300_000));
    expect(table(sw1)).toEqual([]);
    expect(send(pc2, pc1)).toEqual(['PC2 > SW1', 'SW1 > PC1', 'SW1 > PC3']);
  });

  it('forgets the addresses on a port whose link goes down', () => {
    const { lab, engine, sw1, pc1, pc2, mac, send, table } = switchedLab();
    send(pc1, pc2);
    send(pc2, pc1);

    engine.applyPatch({ devices: { [pc1]: { ...lab.device(pc1), powered: false } }, links: {} });

    expect(table(sw1)).toEqual([[1, mac(pc2), 'FastEthernet0/2']]);
  });

  it('keeps access VLANs apart', () => {
    const { pc1, pc3, send } = switchedLab({
      switchports: {
        'FastEthernet0/1': access(10),
        'FastEthernet0/2': access(20),
        'FastEthernet0/3': access(10),
      },
    });

    expect(send(pc1, BROADCAST_MAC)).toEqual(['PC1 > SW1', 'SW1 > PC3']);
    expect(send(pc3, pc1)).toEqual(['PC3 > SW1', 'SW1 > PC1']);
  });

  it('tags a frame across a trunk and strips the tag at the far access port', () => {
    const { engine, pc1, send } = switchedLab({
      switchports: { 'FastEthernet0/1': access(10) },
      uplink: trunk(1),
      sw2Port: access(10),
    });
    const mark = engine.log.lastId;

    expect(send(pc1, BROADCAST_MAC)).toEqual(['PC1 > SW1', 'SW1 > SW2', 'SW2 > PC4']);
    const tags = engine.log
      .since(mark)
      .flatMap((event) =>
        event.kind === 'frame' &&
        event.frame.kind === 'ethernet' &&
        event.frame.payload.kind !== 'bpdu'
          ? [event.frame.tag]
          : [],
      );
    expect(tags).toEqual([undefined, { vlan: 10 }, undefined]);
  });

  it('sends the native VLAN untagged across a trunk', () => {
    const { engine, pc2, send } = switchedLab({ uplink: trunk(1) });
    const mark = engine.log.lastId;

    expect(send(pc2, BROADCAST_MAC)).toEqual([
      'PC2 > SW1',
      'SW1 > PC1',
      'SW1 > PC3',
      'SW1 > SW2',
      'SW2 > PC4',
    ]);
    const tagged = engine.log
      .since(mark)
      .filter(
        (event) =>
          event.kind === 'frame' &&
          event.frame.kind === 'ethernet' &&
          event.frame.payload.kind !== 'bpdu' &&
          event.frame.tag,
      );
    expect(tagged).toEqual([]);
  });
});
