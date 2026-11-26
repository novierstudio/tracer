import { describe, expect, it } from 'vitest';
import type { FetchEvent, PingEvent, TerminalEvent } from '@/engine/api';
import { ms, simTime } from '@/engine/core/time';
import { createEngine } from '@/engine/engine';
import { createSimService } from '@/engine/service';
import { STACKS } from '@/engine/stacks';
import { Ipv4Address, parseTopologyJson, serializeTopology, type Topology } from '@/model';
import { readIpv6 } from '@/model/ipv6';
import { BUILDERS } from './build';
import { SAMPLE_LABS } from './catalog';

/** The ping each lab is built to answer: from PC1 to an address across the network. */
const HEADLINE_PING: Record<string, string> = {
  'two-pcs-switch': '192.168.1.11',
  'two-lans-router': '192.168.2.10',
  'static-routes-serial': '192.168.2.10',
  'router-on-a-stick': '192.168.20.10',
  'layer3-switch': '192.168.20.10',
  'stp-triangle': '192.168.1.11',
  'dhcp-router': '192.168.1.1',
  'ospf-three-routers': '192.168.3.10',
  'eigrp-feasible-successor': '192.168.3.10',
  'dns-web-server': '192.168.1.20',
  'pat-acl': '203.0.113.10',
  // PC3's SLAAC address: LAN B's prefix and PC3's MAC, b2:1f:56:da:90:69, by EUI-64.
  'ipv6-slaac': '2001:db8:2:0:b01f:56ff:feda:9069',
  'remote-management': '192.168.1.1',
  etherchannel: '192.168.1.11',
  'port-security': '192.168.1.11',
};

async function load(id: string): Promise<Topology> {
  const sample = SAMPLE_LABS.find((lab) => lab.id === id)!;
  const parsed = parseTopologyJson(await sample.load());
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
}

/**
 * When every lab has settled: spanning tree forwards after 4 s, and OSPF elects its DRs after its
 * 8 s wait and is FULL a moment later, on the default fast timers.
 */
const SETTLED = simTime(10_000);

/**
 * Loads the lab into the engine, lets it settle and every DHCP host get its lease, pings, and
 * returns what came back.
 */
function ping(topology: Topology, target: string) {
  const engine = createEngine({ seed: 1, stacks: STACKS, linkDelay: ms(1) });
  const sim = createSimService({ engine, frames: { now: () => 0, request: () => {} } });
  sim.load(topology);
  engine.runUntil(SETTLED);
  const dhcpHosts = Object.values(topology.devices).filter(
    (device) =>
      (device.kind === 'pc' || device.kind === 'server') && device.config.ipv4.mode === 'dhcp',
  );
  const leased = () =>
    dhcpHosts.every((host) => {
      const addressing = sim.hostIp(host.id);
      return addressing.ok && addressing.value.kind === 'leased';
    });
  while (!leased() && engine.nextTime() !== undefined) engine.step();
  const events: PingEvent[] = [];
  const options = { count: 4, timeoutMs: 1000 };
  const pc1 = Object.values(topology.devices).find((d) => d.config.hostname === 'PC1')!;
  const address = readIpv6(target) ?? Ipv4Address.parse(target);
  const started = sim.ping(pc1.id, address, options, (e) => events.push(e));
  if (!started.ok) throw new Error(started.error);
  while (!events.some((e) => e.kind === 'summary') && engine.nextTime() !== undefined) {
    engine.step();
  }
  return events.find((e) => e.kind === 'summary');
}

it('lists every lab that has a file, and a headline ping for each', () => {
  const ids = SAMPLE_LABS.map((lab) => lab.id);
  expect(ids).toEqual(Object.keys(BUILDERS));
  expect(ids).toEqual(Object.keys(HEADLINE_PING));
});

it('gives every device a different id in each lab, so no console carries over between labs', async () => {
  const ids = [];
  for (const sample of SAMPLE_LABS) ids.push(...Object.keys((await load(sample.id)).devices));
  expect(new Set(ids).size).toBe(ids.length);
});

describe.each(SAMPLE_LABS)('$title', (sample) => {
  it('is the lab its builder makes', async () => {
    const built = `${serializeTopology(BUILDERS[sample.id]!())}\n`;
    await expect(built).toMatchFileSnapshot(`./${sample.id}.tracer.json`);
  });

  it('parses as a topology named after the lab, with the devices its card shows', async () => {
    const topology = await load(sample.id);
    expect(topology.meta.name).toBe(sample.title);
    const kinds: Record<string, number> = {};
    for (const device of Object.values(topology.devices)) {
      kinds[device.kind] = (kinds[device.kind] ?? 0) + 1;
    }
    expect(kinds).toEqual(sample.devices);
  });

  it(`answers PC1's ping to ${HEADLINE_PING[sample.id]}`, async () => {
    const summary = ping(await load(sample.id), HEADLINE_PING[sample.id]!);
    expect(summary).toMatchObject({ kind: 'summary', sent: 4, received: 4 });
  });
});

it('DNS and a web server: PC1 browses to www.lab.local by name and gets Server1’s page', async () => {
  const topology = await load('dns-web-server');
  const engine = createEngine({ seed: 1, stacks: STACKS, linkDelay: ms(1) });
  const sim = createSimService({ engine, frames: { now: () => 0, request: () => {} } });
  sim.load(topology);
  engine.runUntil(SETTLED);
  const pc1 = Object.values(topology.devices).find((d) => d.config.hostname === 'PC1')!;
  const events: FetchEvent[] = [];
  sim.browse(pc1.id, { host: 'www.lab.local', port: 80, path: '/' }, (e) => events.push(e));
  while (!events.some((e) => e.kind === 'response' || e.kind === 'failed')) engine.step();

  expect(events.map((e) => e.kind)).toEqual(['resolving', 'connecting', 'response']);
  expect(events.at(-1)).toMatchObject({
    kind: 'response',
    response: { status: 200, body: expect.stringContaining('Welcome to www.lab.local') },
  });
});

it('Remote management: PC1 reaches R1 by SSH, and R1 refuses its Telnet', async () => {
  const topology = await load('remote-management');
  const engine = createEngine({ seed: 1, stacks: STACKS, linkDelay: ms(1) });
  const sim = createSimService({ engine, frames: { now: () => 0, request: () => {} } });
  sim.load(topology);
  engine.runUntil(SETTLED);
  const pc1 = Object.values(topology.devices).find((d) => d.config.hostname === 'PC1')!;
  const open = (protocol: 'ssh' | 'telnet') => {
    const events: TerminalEvent[] = [];
    sim.openTerminal(pc1.id, Ipv4Address.parse('192.168.1.1'), protocol, (e) => events.push(e));
    while (events.length === 0 && engine.nextTime() !== undefined) engine.step();
    return events[0];
  };
  expect(open('ssh')).toMatchObject({ kind: 'open' });
  expect(open('telnet')).toEqual({ kind: 'failed', why: 'refused' });
});
