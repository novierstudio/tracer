import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createIdSource, type DeviceId } from '@/model';
import { importPkt } from '@/importers/pkt/mapper';
import type { PingEvent } from '../api';
import { ms } from '../core/time';
import { createEngine } from '../engine';
import { createSimService } from '../service';
import { STACKS } from '../stacks';
import { ip } from '../testing';

/**
 * Router1 - Router2 - Router3 - Router4 in a chain, each with a loopback, saved by Packet Tracer
 * 7.1 for an EIGRP lab. EIGRP is not simulated, so only neighbours and own addresses answer.
 */
function eigrpLab() {
  const result = importPkt(readFileSync('src/importers/pkt/__fixtures__/pt7.1-eigrp-lab.pkt'), {
    ids: createIdSource(1),
  });
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  const { topology } = result.value;
  const engine = createEngine({ seed: 1, stacks: STACKS, linkDelay: ms(1) });
  const sim = createSimService({ engine, frames: { now: () => 0, request: () => {} } });
  sim.load(topology);

  const named = (hostname: string): DeviceId => {
    const device = Object.values(topology.devices).find((d) => d.config.hostname === hostname);
    if (!device) throw new Error(`no device named ${hostname}`);
    return device.id;
  };
  /** Pings as IOS does by default: five echoes, two seconds each. */
  const ping = (from: string, target: string) => {
    const events: PingEvent[] = [];
    sim.ping(named(from), ip(target), { count: 5, timeoutMs: 2000 }, (event) => events.push(event));
    while (!events.some((event) => event.kind === 'summary') && engine.nextTime() !== undefined) {
      engine.step();
    }
    return events.map((event) =>
      event.kind === 'summary' ? `${event.received}/${event.sent}` : event.kind,
    );
  };
  return { ping };
}

const fiveTimes = (kind: string) => Array.from({ length: 5 }, () => kind);

describe('a lab imported from Packet Tracer', () => {
  it('pings a directly connected neighbour and its own loopback', () => {
    const { ping } = eigrpLab();

    expect(ping('Router1', '10.1.1.2')).toEqual([...fiveTimes('reply'), '5/5']);
    expect(ping('Router3', '10.1.3.2')).toEqual([...fiveTimes('reply'), '5/5']);
    expect(ping('Router1', '1.1.1.1')).toEqual([...fiveTimes('reply'), '5/5']);
  });

  it('times out two hops away, where only EIGRP would have taught it a route', () => {
    const { ping } = eigrpLab();

    expect(ping('Router1', '10.1.2.2')).toEqual([...fiveTimes('timeout'), '0/5']);
  });
});
