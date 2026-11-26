import { describe, expect, it } from 'vitest';
import {
  LinkId,
  MacAddress,
  PortId,
  type Device,
  type DeviceId,
  type Link,
  type PortSecurity,
} from '@/model';
import type { PingEvent } from '../api';
import { after, ms } from '../core/time';
import { createEngine } from '../engine';
import type { EventId } from '../events';
import { createSimService } from '../service';
import { STACKS } from '../stacks';
import { ip, labBuilder, STP_CONVERGED } from '../testing';

const FA1 = PortId.parse('FastEthernet0/1');

type Switch = Extract<Device, { kind: 'switch' }>;

/**
 * SW1 with PC1 on Fa0/1, the secure port, and PC3 on Fa0/3. PC2 waits uncabled, to be moved onto
 * Fa0/1 in PC1's place. Sticky addresses the switch learns go into its config, as the app does.
 */
function lab(security: Partial<PortSecurity>, edit: (device: Switch) => void = () => {}) {
  const builder = labBuilder();
  const sw1 = builder.switch('SW1');
  const pc1 = builder.host('pc', 'PC1', '10.0.0.1/24');
  const pc2 = builder.host('pc', 'PC2', '10.0.0.2/24');
  const pc3 = builder.host('pc', 'PC3', '10.0.0.3/24');
  builder.connect(pc1, 'FastEthernet0', sw1, 'FastEthernet0/1');
  builder.connect(pc3, 'FastEthernet0', sw1, 'FastEthernet0/3');
  builder.edit(sw1, (device) => {
    if (device.kind !== 'switch') throw new Error('not a switch');
    const copy = structuredClone(device);
    copy.config.interfaces[FA1] = {
      ...copy.config.interfaces[FA1]!,
      modeAccess: true,
      portSecurity: { enabled: true, addresses: [], ...security },
    };
    edit(copy);
    return copy;
  });
  let topology = builder.topology;

  const engine = createEngine({ seed: 1, stacks: STACKS, linkDelay: ms(1) });
  const sim = createSimService({ engine, frames: { now: () => 0, request: () => {} } });
  sim.load(topology);
  let seen = engine.log.lastId;

  /** Writes learned sticky addresses into the config, as the app's tracker does. */
  const settle = () => {
    for (const event of engine.log.since(seen)) {
      if (event.kind !== 'sticky-mac') continue;
      const device = structuredClone(topology.devices[event.device] as Switch);
      device.config.interfaces[event.port]!.portSecurity!.addresses.push({
        mac: event.mac,
        sticky: true,
      });
      topology = { ...topology, devices: { ...topology.devices, [device.id]: device } };
      engine.applyPatch({ devices: { [device.id]: device }, links: {} });
    }
    seen = engine.log.lastId;
  };
  const runFor = (millis: number) => {
    engine.runUntil(after(engine.now, ms(millis)));
    settle();
  };
  const ping = (from: DeviceId, to: string, count = 1) => {
    const events: PingEvent[] = [];
    const started = sim.ping(from, ip(to), { count, timeoutMs: 1000 }, (event) =>
      events.push(event),
    );
    if (!started.ok) throw new Error(started.error);
    while (!events.some((event) => event.kind === 'summary')) engine.step();
    settle();
    return events.at(-1)!;
  };
  const fa1Link = () =>
    Object.values(topology.links).find((link) => link.b.device === sw1 && link.b.port === FA1)!;
  /** Unplugs PC1 from Fa0/1 and plugs PC2 in. */
  const swapToPc2 = () => {
    const old = fa1Link();
    const next: Link = {
      id: LinkId.parse('lnk_pc2'),
      cable: 'straight',
      a: { device: pc2, port: PortId.parse('FastEthernet0') },
      b: { device: sw1, port: FA1 },
    };
    topology = {
      ...topology,
      links: Object.fromEntries([
        ...Object.entries(topology.links).filter(([id]) => id !== old.id),
        [next.id, next],
      ]) as typeof topology.links,
    };
    engine.applyPatch({ devices: {}, links: { [old.id]: null, [next.id]: next } });
  };
  const setInterface = (shutdown: boolean) => {
    const device = structuredClone(topology.devices[sw1] as Switch);
    device.config.interfaces[FA1]!.shutdown = shutdown;
    topology = { ...topology, devices: { ...topology.devices, [sw1]: device } };
    engine.applyPatch({ devices: { [sw1]: device }, links: {} });
  };
  const secure = () => {
    const result = sim.layer2Status(sw1);
    if (!result.ok) throw new Error(result.error);
    return result.value;
  };
  const fa1 = () => secure().portSecurity.find((port) => port.port === FA1)!;
  const syslog = (since: EventId) =>
    engine.log
      .since(since)
      .flatMap((event) => (event.kind === 'syslog' && event.device === sw1 ? [event.text] : []));
  const fa1Up = () => engine.linkStates()[fa1Link().id]?.a !== 'down';
  const macOf = (id: DeviceId) => {
    const port = topology.devices[id]!.ports[0]!;
    if (port.kind === 'serial') throw new Error('serial');
    return port.mac;
  };
  const config = () => (topology.devices[sw1] as Switch).config.interfaces[FA1]!.portSecurity!;
  return {
    engine,
    sw1,
    pc1,
    pc2,
    pc3,
    runFor,
    ping,
    swapToPc2,
    setInterface,
    fa1,
    syslog,
    fa1Up,
    macOf,
    config,
  };
}

describe('port security', () => {
  it('secures the first address it hears, and forgets a dynamic one when the link goes down', () => {
    const l = lab({});
    l.runFor(STP_CONVERGED);
    expect(l.ping(l.pc1, '10.0.0.3')).toMatchObject({ received: 1 });
    expect(l.fa1().addresses).toEqual([
      expect.objectContaining({ mac: l.macOf(l.pc1), type: 'dynamic' }),
    ]);
    l.swapToPc2();
    l.runFor(STP_CONVERGED);
    // PC1's address went with its link, so PC2 is the port's one address now: no violation.
    expect(l.ping(l.pc2, '10.0.0.3')).toMatchObject({ received: 1 });
    expect(l.fa1()).toMatchObject({ state: 'secure-up', violations: 0 });
  });

  it('writes a sticky address into the config, and a second PC on the port err-disables it', () => {
    const l = lab({ sticky: true });
    l.runFor(STP_CONVERGED);
    l.ping(l.pc1, '10.0.0.3');
    expect(l.config().addresses).toEqual([{ mac: l.macOf(l.pc1), sticky: true }]);
    expect(l.fa1().addresses).toEqual([
      expect.objectContaining({ mac: l.macOf(l.pc1), type: 'sticky' }),
    ]);

    l.swapToPc2();
    l.runFor(STP_CONVERGED);
    const before = l.engine.log.lastId;
    expect(l.ping(l.pc2, '10.0.0.3')).toMatchObject({ received: 0 });
    expect(l.fa1Up()).toBe(false);
    expect(l.fa1()).toMatchObject({
      state: 'secure-shutdown',
      violations: 1,
      lastSource: { mac: l.macOf(l.pc2) },
    });
    const mac = l.macOf(l.pc2).replace(/:/g, '').match(/.{4}/g)!.join('.');
    expect(l.syslog(before).slice(0, 2)).toEqual([
      '%PM-4-ERR_DISABLE: psecure-violation error detected on Fa0/1, putting Fa0/1 in err-disable state',
      `%PORT_SECURITY-2-PSECURE_VIOLATION: Security violation occurred, caused by MAC address ${mac} on port FastEthernet0/1.`,
    ]);
  });

  it('a configured address keeps every other one off the port', () => {
    const l = lab({ addresses: [{ mac: MacAddress.parse('00:11:22:33:44:55'), sticky: false }] });
    l.runFor(STP_CONVERGED);
    expect(l.ping(l.pc1, '10.0.0.3')).toMatchObject({ received: 0 });
    expect(l.fa1()).toMatchObject({ state: 'secure-shutdown', violations: 1 });
  });

  it('restrict drops and counts each violating frame, and the port stays up', () => {
    const l = lab({ violation: 'restrict', maximum: 1 }, (device) => {
      device.config.interfaces[FA1]!.portSecurity!.addresses = [
        { mac: MacAddress.parse('00:11:22:33:44:55'), sticky: false },
      ];
    });
    l.runFor(STP_CONVERGED);
    const before = l.engine.log.lastId;
    expect(l.ping(l.pc1, '10.0.0.3', 3)).toMatchObject({ received: 0 });
    expect(l.fa1Up()).toBe(true);
    const { violations } = l.fa1();
    expect(violations).toBeGreaterThanOrEqual(3);
    expect(l.syslog(before).filter((text) => text.includes('PSECURE_VIOLATION'))).toHaveLength(
      violations,
    );
    expect(l.fa1().state).toBe('secure-up');
  });

  it('protect drops violating frames without counting them', () => {
    const l = lab({ violation: 'protect' }, (device) => {
      device.config.interfaces[FA1]!.portSecurity!.addresses = [
        { mac: MacAddress.parse('00:11:22:33:44:55'), sticky: false },
      ];
    });
    l.runFor(STP_CONVERGED);
    const before = l.engine.log.lastId;
    expect(l.ping(l.pc1, '10.0.0.3', 2)).toMatchObject({ received: 0 });
    expect(l.fa1()).toMatchObject({ state: 'secure-up', violations: 0 });
    expect(l.syslog(before)).toEqual([]);
  });

  it('a maximum of 2 takes a second address', () => {
    const l = lab({ maximum: 2, sticky: true });
    l.runFor(STP_CONVERGED);
    l.ping(l.pc1, '10.0.0.3');
    l.swapToPc2();
    l.runFor(STP_CONVERGED);
    expect(l.ping(l.pc2, '10.0.0.3')).toMatchObject({ received: 1 });
    expect(l.config().addresses.map((entry) => entry.mac)).toEqual([
      l.macOf(l.pc1),
      l.macOf(l.pc2),
    ]);
  });

  it('shutdown then no shutdown brings an err-disabled port back', () => {
    const l = lab({ addresses: [{ mac: MacAddress.parse('00:11:22:33:44:55'), sticky: false }] });
    l.runFor(STP_CONVERGED);
    l.ping(l.pc1, '10.0.0.3');
    expect(l.fa1Up()).toBe(false);
    l.setInterface(true);
    expect(l.fa1().state).toBe('secure-down');
    l.setInterface(false);
    expect(l.fa1Up()).toBe(true);
    expect(l.fa1().state).toBe('secure-up');
  });

  it('errdisable recovery brings the port back after its interval', () => {
    const l = lab(
      { addresses: [{ mac: MacAddress.parse('00:11:22:33:44:55'), sticky: false }] },
      (device) => {
        device.config.errdisableRecovery = { psecureViolation: true, interval: 30 };
      },
    );
    l.runFor(STP_CONVERGED);
    l.ping(l.pc1, '10.0.0.3');
    expect(l.fa1Up()).toBe(false);
    const before = l.engine.log.lastId;
    l.runFor(30_000);
    expect(l.fa1Up()).toBe(true);
    expect(l.syslog(before)[0]).toBe(
      '%PM-4-ERR_RECOVER: Attempting to recover from psecure-violation err-disable state on Fa0/1',
    );
  });

  it('ages dynamic addresses out after the aging time', () => {
    const l = lab({ agingTime: 1 });
    l.runFor(STP_CONVERGED);
    l.ping(l.pc1, '10.0.0.3');
    expect(l.fa1().addresses[0]).toMatchObject({ type: 'dynamic', remainingAge: 1 });
    l.runFor(61_000);
    expect(l.fa1().addresses).toEqual([]);
  });
});
