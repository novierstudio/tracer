import { describe, expect, it } from 'vitest';
import { PortId, type DeviceId, type MacAddress } from '@/model';
import type { PingEvent } from './api';
import { ms, simTime } from './core/time';
import { createEngine } from './engine';
import type { SimEvent } from './events';
import { hubModule } from './hub';
import type { SimModule } from './module';
import { BROADCAST_MAC, type EthernetFrame } from './pdu';
import { createSimService } from './service';
import { STACKS } from './stacks';
import { ip, labBuilder, stacksOf } from './testing';

/** A host that sends what a test tells it to and runs no protocol. */
const nic: SimModule<null> = { id: 'nic', init: () => null };

const FA0 = PortId.parse('FastEthernet0');

/** PC1 to PC3 on Hub1's Port0 to Port2, and Port3 to Port5 free. */
function hubLab() {
  const lab = labBuilder();
  const hub = lab.hub('Hub1');
  const pcs = [1, 2, 3].map((n) => {
    const pc = lab.host('pc', `PC${n}`, `10.0.0.${n}/24`);
    lab.connect(pc, 'FastEthernet0', hub, `Port${n - 1}`);
    return pc;
  }) as [DeviceId, DeviceId, DeviceId];
  const engine = createEngine({
    seed: 1,
    stacks: stacksOf({ hub: [hubModule], pc: [nic] }),
    linkDelay: ms(1),
  });
  engine.load(lab.topology);

  const name = (id: DeviceId) => lab.device(id).config.hostname;
  const mac = (id: DeviceId) => {
    const port = lab.device(id).ports[0]!;
    if (port.kind === 'serial') throw new Error('no MAC on a serial port');
    return port.mac;
  };
  const frame = (src: DeviceId, dst: MacAddress): EthernetFrame => ({
    kind: 'ethernet',
    dst,
    src: mac(src),
    payload: {
      kind: 'arp',
      op: 'request',
      senderMac: mac(src),
      senderIp: ip('10.0.0.1'),
      targetMac: dst,
      targetIp: ip('10.0.0.2'),
    },
  });
  const hops = (events: SimEvent[]) =>
    events.flatMap((event) =>
      event.kind === 'frame'
        ? [`${name(event.from.device)} > ${name(event.to.device)} ${event.outcome}`]
        : [],
    );
  /** Each host in `from` sends one frame at the same instant. Returns every hop, with its fate. */
  const send = (from: readonly DeviceId[], dst: MacAddress = BROADCAST_MAC) => {
    for (const host of from) {
      engine.withModule(host, nic, (ctx) => ctx.send(FA0, frame(host, dst)));
    }
    return hops(engine.runUntil(simTime(engine.now + 10)));
  };
  return { lab, engine, pcs, mac, send };
}

describe('a hub', () => {
  it('takes a straight-through cable to a PC, as a switch does, and every link comes up', () => {
    const { lab, engine } = hubLab();

    expect(Object.values(lab.topology.links).map((link) => link.cable)).toEqual([
      'straight',
      'straight',
      'straight',
    ]);
    expect(Object.values(engine.linkStates())).toEqual(
      Array.from({ length: 3 }, () => ({ a: 'up', b: 'up' })),
    );
  });

  it('repeats a frame out of every other port, never the one it came in on', () => {
    const { pcs, send } = hubLab();

    expect(send([pcs[0]])).toEqual([
      'PC1 > Hub1 delivered',
      'Hub1 > PC2 delivered',
      'Hub1 > PC3 delivered',
    ]);
  });

  it('repeats a unicast frame everywhere too, since it reads no address', () => {
    const { pcs, mac, send } = hubLab();

    expect(send([pcs[0]], mac(pcs[1]))).toEqual([
      'PC1 > Hub1 delivered',
      'Hub1 > PC2 delivered',
      'Hub1 > PC3 delivered',
    ]);
  });

  it('loses both frames when two reach it at once in Simulation mode', () => {
    const { engine, pcs, send } = hubLab();
    engine.detectCollisions(true);

    expect(send([pcs[0], pcs[1]])).toEqual(['PC1 > Hub1 collision', 'PC2 > Hub1 collision']);
  });

  it('repeats frames that reach it one after the other, even in Simulation mode', () => {
    const { engine, pcs, send } = hubLab();
    engine.detectCollisions(true);

    expect(send([pcs[0]])).toHaveLength(3);
    expect(send([pcs[1]])).toEqual([
      'PC2 > Hub1 delivered',
      'Hub1 > PC1 delivered',
      'Hub1 > PC3 delivered',
    ]);
  });

  it('repeats both of two frames that reach it at once in realtime', () => {
    const { pcs, send } = hubLab();

    expect(send([pcs[0], pcs[1]])).toEqual([
      'PC1 > Hub1 delivered',
      'PC2 > Hub1 delivered',
      'Hub1 > PC2 delivered',
      'Hub1 > PC3 delivered',
      'Hub1 > PC1 delivered',
      'Hub1 > PC3 delivered',
    ]);
  });

  it('carries a ping between two PCs on its segment', () => {
    const lab = labBuilder();
    const hub = lab.hub('Hub1');
    const pc1 = lab.host('pc', 'PC1', '10.0.0.1/24');
    const pc2 = lab.host('pc', 'PC2', '10.0.0.2/24');
    lab.connect(pc1, 'FastEthernet0', hub, 'Port0');
    lab.connect(pc2, 'FastEthernet0', hub, 'Port1');
    const engine = createEngine({ seed: 1, stacks: STACKS, linkDelay: ms(1) });
    const sim = createSimService({ engine, frames: { now: () => 0, request: () => {} } });
    sim.load(lab.topology);

    const events: PingEvent[] = [];
    sim.ping(pc1, ip('10.0.0.2'), { count: 4, timeoutMs: 1000 }, (event) => events.push(event));
    while (!events.some((event) => event.kind === 'summary')) engine.step();

    expect(events.at(-1)).toMatchObject({ kind: 'summary', sent: 4, received: 4 });
  });

  it('collides two pings sent at once in Simulation mode, and both time out', () => {
    const lab = labBuilder();
    const hub = lab.hub('Hub1');
    const pcs = [1, 2, 3].map((n) => {
      const pc = lab.host('pc', `PC${n}`, `10.0.0.${n}/24`);
      lab.connect(pc, 'FastEthernet0', hub, `Port${n - 1}`);
      return pc;
    });
    const engine = createEngine({ seed: 1, stacks: STACKS, linkDelay: ms(1) });
    const sim = createSimService({ engine, frames: { now: () => 0, request: () => {} } });
    sim.load(lab.topology);
    sim.setMode('simulation');

    const summaries: PingEvent[] = [];
    const options = { count: 1, timeoutMs: 1000 };
    const done = (event: PingEvent) => event.kind === 'summary' && summaries.push(event);
    sim.ping(pcs[0]!, ip('10.0.0.3'), options, done);
    sim.ping(pcs[1]!, ip('10.0.0.3'), options, done);
    while (summaries.length < 2) sim.step();

    expect(summaries).toMatchObject([
      { sent: 1, received: 0 },
      { sent: 1, received: 0 },
    ]);
  });
});
