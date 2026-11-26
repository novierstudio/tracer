import { describe, expect, it } from 'vitest';
import type { Device, DeviceId, Topology } from '../../model';
import type { RouterConfig } from '../../model';
import { ms, simTime } from '../../engine/core/time';
import { createEngine } from '../../engine/engine';
import { createSimService } from '../../engine/service';
import { STACKS } from '../../engine/stacks';
import { labBuilder } from '../../engine/testing';
import type { IosDevice } from './context';
import type { EngineAnswers, EngineQueryKind } from './query';
import { applyLines, withBlankConfig } from './session';
import { runningConfig } from './show';
import { consoleOn, router } from './testing';

const ENTER = ['enable', 'configure terminal'];

/** Runs `lines` from global config on a new router and returns its console. */
function configured(lines: readonly string[]) {
  const c = consoleOn(router());
  const output = c.runAll([...ENTER, ...lines]).slice(1);
  const config = () => c.device.config as RouterConfig;
  return { c, output, config };
}

/** Replays `lines` from global config onto the router, as a .pkt import or a lab file does. */
function withLines(topology: Topology, id: DeviceId, lines: readonly string[]): Topology {
  const device = topology.devices[id]!;
  const { config, errors } = applyLines(device as IosDevice, lines);
  if (errors.length > 0) throw new Error(JSON.stringify(errors));
  return { ...topology, devices: { ...topology.devices, [id]: { ...device, config } as Device } };
}

/**
 * R1, R2 and R3 in a triangle: R1-R2 and R2-R3 on Gigabit Ethernet, R1-R3 on a T1. Each has a
 * LAN 192.168.n.0/24 and a loopback n.n.n.n, and runs EIGRP AS 10 as typed at the CLI.
 */
function triangle() {
  const lab = labBuilder();
  const r1 = lab.router('R1', {
    Loopback0: '1.1.1.1/32',
    'GigabitEthernet0/0': '192.168.1.1/24',
    'GigabitEthernet0/1': '10.0.12.1/30',
    'Serial0/0/0': '10.0.13.1/30',
  });
  const r2 = lab.router('R2', {
    Loopback0: '2.2.2.2/32',
    'GigabitEthernet0/0': '192.168.2.1/24',
    'GigabitEthernet0/1': '10.0.12.2/30',
    'GigabitEthernet0/2': '10.0.23.2/30',
  });
  const r3 = lab.router('R3', {
    Loopback0: '3.3.3.3/32',
    'GigabitEthernet0/0': '192.168.3.1/24',
    'GigabitEthernet0/2': '10.0.23.1/30',
    'Serial0/0/0': '10.0.13.2/30',
  });
  lab.connect(r1, 'GigabitEthernet0/1', r2, 'GigabitEthernet0/1');
  lab.connect(r2, 'GigabitEthernet0/2', r3, 'GigabitEthernet0/2');
  lab.connect(r1, 'Serial0/0/0', r3, 'Serial0/0/0');
  [r1, r2, r3].forEach((id, i) => {
    const pc = lab.host('pc', `PC${i + 1}`, `192.168.${i + 1}.10/24`, `192.168.${i + 1}.1`);
    lab.connect(pc, 'FastEthernet0', id, 'GigabitEthernet0/0');
  });
  let topology = lab.topology;
  [r1, r2, r3].forEach((id, i) => {
    const n = i + 1;
    topology = withLines(topology, id, [
      'router eigrp 10',
      `network 192.168.${n}.0`,
      'network 10.0.0.0',
      `network ${n}.${n}.${n}.${n} 0.0.0.0`,
      'passive-interface GigabitEthernet0/0',
    ]);
  });
  return { topology, r1, r2, r3 };
}

/** Runs the lab for `seconds`, then a show command on `id` answered by the simulation. */
function liveShow(topology: Topology, id: DeviceId, seconds: number) {
  const engine = createEngine({ seed: 1, stacks: STACKS, linkDelay: ms(1) });
  const sim = createSimService({ engine, frames: { now: () => 0, request: () => {} } });
  sim.load(topology);
  engine.runUntil(simTime(seconds * 1000));
  const answers: { [K in EngineQueryKind]?: () => EngineAnswers[K] } = {
    protocols: () => {
      const result = sim.routingProtocols(id);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    },
    routes: () => {
      const result = sim.routes(id);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    },
  };
  const c = consoleOn(topology.devices[id] as IosDevice);
  return (line: string) => {
    const { query } = c.session.run(c.device, line);
    if (!query) throw new Error(`${line} asked nothing`);
    const answer = answers[query.kind];
    if (!answer) throw new Error(`${line} asked for ${query.kind}`);
    return (query.render as (a: unknown) => readonly string[])(answer());
  };
}

describe('router eigrp', () => {
  it('enters EIGRP config, keeps networks as IOS does, and lists them in the running-config', () => {
    const { c, config } = configured([
      'router eigrp 10',
      'network 10.1.1.0',
      'network 192.168.1.77 0.0.0.255',
      'network 10.1.1.0',
    ]);

    expect(c.prompt).toBe('Router(config-router)#');
    // Without a wildcard IOS keeps the classful network; with one, the address under it.
    expect(config().eigrp?.networks).toEqual([
      { address: '10.0.0.0' },
      { address: '192.168.1.0', wildcard: '0.0.0.255' },
    ]);
    c.run('no network 192.168.1.0 0.0.0.255');
    expect(config().eigrp?.networks).toEqual([{ address: '10.0.0.0' }]);
  });

  it('takes the router ID, variance, K-values, passive interfaces and redistribution', () => {
    const { config, output } = configured([
      'router eigrp 1',
      'eigrp router-id 1.1.1.1',
      'variance 2',
      'metric weights 0 1 0 1 0 0',
      'passive-interface g0/0',
      'redistribute static metric 1544 2000 255 1 1500',
      'network 10.0.0.0',
    ]);

    expect(output.filter((line) => line !== '')).toEqual([]);
    expect(config().eigrp).toEqual({
      asn: 1,
      routerId: '1.1.1.1',
      variance: 2,
      passiveInterfaces: ['GigabitEthernet0/0'],
      redistributeStatic: {
        metric: { bandwidth: 1544, delay: 2000, reliability: 255, load: 1, mtu: 1500 },
      },
      networks: [{ address: '10.0.0.0' }],
    });
  });

  it('refuses a second process and auto-summary, and is removed by its own number', () => {
    const { c, config } = configured(['router eigrp 1', 'no auto-summary']);

    expect(c.run('auto-summary')).toEqual([
      '% Tracer does not summarize EIGRP routes: auto-summary stays off, as in IOS 15.',
    ]);
    c.run('exit');
    expect(c.run('router eigrp 2')).toEqual([
      '% Tracer runs one EIGRP process per router. Remove router eigrp 1 first.',
    ]);
    c.run('no router eigrp 2');
    expect(config().eigrp?.asn).toBe(1);
    c.run('no router eigrp 1');
    expect(config().eigrp).toBe(undefined);
  });

  it('offers its commands and their arguments as help', () => {
    const { c } = configured([]);
    expect(c.session.help(c.device, 'router ')).toContain(
      '  eigrp  Enhanced Interior Gateway Routing Protocol (EIGRP)',
    );
    expect(c.session.help(c.device, 'router eigrp ')).toEqual([
      '  <1-65535>  Autonomous system number',
    ]);
    c.run('router eigrp 1');
    expect(c.session.help(c.device, '')).toEqual([
      '  auto-summary       Enable automatic network number summarization',
      '  do                 To run exec commands in config mode',
      '  eigrp              EIGRP specific commands',
      '  end                Exit from configure mode',
      '  exit               Exit from configure mode',
      '  metric             Modify EIGRP routing metrics and parameters',
      '  network            Enable routing on an IP network',
      '  no                 Negate a command or set its defaults',
      '  passive-interface  Suppress routing updates on an interface',
      '  redistribute       Redistribute information from another routing protocol',
      '  variance           Control load balancing variance',
    ]);
    expect(c.session.help(c.device, 'network 10.0.0.0 ')).toEqual([
      '  A.B.C.D  EIGRP wild card bits',
      '  <cr>',
    ]);
    expect(c.session.help(c.device, 'variance ')).toEqual([
      '  <1-128>  Metric variance multiplier',
    ]);
  });
});

describe('interface bandwidth and delay', () => {
  it('lists them in the running-config, and show interfaces reports them', () => {
    const { c } = configured([
      'interface s0/0/0',
      'bandwidth 64',
      'ip address 10.0.0.1 255.255.255.252',
      'delay 100',
      'no shutdown',
      'end',
    ]);

    const block = runningConfig(c.device);
    const at = block.indexOf('interface Serial0/0/0');
    expect(block.slice(at, at + 5)).toEqual([
      'interface Serial0/0/0',
      ' bandwidth 64',
      ' ip address 10.0.0.1 255.255.255.252',
      ' delay 100',
      '!',
    ]);
    expect(c.run('show interfaces s0/0/0')).toContain(
      '  MTU 1500 bytes, BW 64 Kbit, DLY 1000 usec,',
    );
  });

  it('round-trips the running-config through a blank router', () => {
    const { c } = configured([
      'interface g0/0',
      'bandwidth 100000',
      'delay 10',
      'interface lo0',
      'ip address 1.1.1.1 255.255.255.255',
      'router eigrp 7',
      'eigrp router-id 1.1.1.1',
      'metric weights 0 1 1 1 0 0',
      'variance 3',
      'redistribute static',
      'passive-interface g0/0',
      'network 1.1.1.1 0.0.0.0',
      'network 172.16.0.0',
      'end',
    ]);

    const { config, errors } = applyLines(withBlankConfig(c.device), runningConfig(c.device));
    expect(errors).toEqual([]);
    expect(config).toEqual(c.device.config);
    expect(runningConfig({ ...c.device, config })).toContain(' metric weights 0 1 1 1 0 0');
  });
});

describe('EIGRP as the simulation runs it', () => {
  it('lists neighbours in Packet Tracer’s columns', () => {
    const { topology, r1 } = triangle();
    expect(liveShow(topology, r1, 3)('show ip eigrp neighbors')).toEqual([
      'IP-EIGRP neighbors for process 10',
      'H   Address         Interface      Hold Uptime    SRTT   RTO   Q   Seq',
      '                                   (sec)          (ms)        Cnt  Num',
      '0   10.0.12.2       Gig0/1         5    00:00:02  40     1000  0   7',
      '1   10.0.13.2       Se0/0/0        5    00:00:02  40     1000  0   9',
    ]);
  });

  it('shows successors and feasible successors, and every path with all-links', () => {
    const { topology, r1 } = triangle();
    const show = liveShow(topology, r1, 3);
    const table = show('show ip eigrp topology');

    expect(table.slice(0, 5)).toEqual([
      'IP-EIGRP Topology Table for AS 10/ID(1.1.1.1)',
      '',
      'Codes: P - Passive, A - Active, U - Update, Q - Query, R - Reply,',
      '       r - Reply status',
      '',
    ]);
    const lan3 = table.indexOf('P 192.168.3.0/24, 1 successors, FD is 3328');
    expect(table.slice(lan3, lan3 + 3)).toEqual([
      'P 192.168.3.0/24, 1 successors, FD is 3328',
      '         via 10.0.12.2 (3328/3072), GigabitEthernet0/1',
      '         via 10.0.13.2 (2170112/2816), Serial0/0/0',
    ]);
    const lan2 = table.indexOf('P 192.168.2.0/24, 1 successors, FD is 3072');
    expect(table.slice(lan2, lan2 + 2)).toEqual([
      'P 192.168.2.0/24, 1 successors, FD is 3072',
      '         via 10.0.12.2 (3072/2816), GigabitEthernet0/1',
    ]);
    expect(table).toContain('         via Connected, GigabitEthernet0/0');

    // R3 reaches R2's LAN through R2, at no less than R1's FD: not feasible, so all-links only.
    const all = show('show ip eigrp topology all-links');
    const lan2All = all.indexOf('P 192.168.2.0/24, 1 successors, FD is 3072');
    expect(all.slice(lan2All, lan2All + 3)).toEqual([
      'P 192.168.2.0/24, 1 successors, FD is 3072',
      '         via 10.0.12.2 (3072/2816), GigabitEthernet0/1',
      '         via 10.0.13.2 (2170368/3072), Serial0/0/0',
    ]);
  });

  it('lists the interfaces it says hello out of, passive ones left out', () => {
    const { topology, r1 } = triangle();
    expect(liveShow(topology, r1, 3)('show ip eigrp interfaces')).toEqual([
      'IP-EIGRP interfaces for process 10',
      '',
      '                        Xmit Queue   Mean   Pacing Time   Multicast    Pending',
      'Interface        Peers  Un/Reliable  SRTT   Un/Reliable   Flow Timer   Routes',
      'Gig0/1             1        0/0      1236       0/10           0           0',
      'Se0/0/0            1        0/0      1236       0/10           0           0',
      'Lo0                0        0/0      1236       0/10           0           0',
    ]);
  });

  it('describes the process in show ip protocols', () => {
    const { topology, r1 } = triangle();
    const lines = liveShow(topology, r1, 3)('show ip protocols');
    expect(lines.slice(0, 19)).toEqual([
      'Routing Protocol is "eigrp  10 "',
      '  Outgoing update filter list for all interfaces is not set',
      '  Incoming update filter list for all interfaces is not set',
      '  Default networks flagged in outgoing updates',
      '  Default networks accepted from incoming updates',
      '  EIGRP metric weight K1=1, K2=0, K3=1, K4=0, K5=0',
      '  EIGRP maximum hopcount 100',
      '  EIGRP maximum metric variance 1',
      'Redistributing: eigrp 10',
      '  Automatic network summarization is not in effect',
      '  Maximum path: 4',
      '  Routing for Networks:',
      '     192.168.1.0',
      '     10.0.0.0',
      '     1.1.1.1/32',
      '  Passive Interface(s):',
      '    GigabitEthernet0/0',
      '  Routing Information Sources:',
      '    Gateway         Distance      Last Update',
    ]);
    expect(lines.at(-1)).toBe('  Distance: internal 90 external 170');
  });

  it('installs D routes at [90/metric], and D EX for redistributed static routes', () => {
    const { topology, r1, r3 } = triangle();
    let lab = withLines(topology, r3, ['ip route 0.0.0.0 0.0.0.0 192.168.3.10']);
    lab = withLines(lab, r3, ['router eigrp 10', 'redistribute static']);
    const route = liveShow(lab, r1, 3)('show ip route');

    expect(route).toContain('Gateway of last resort is 10.0.12.2 to network 0.0.0.0');
    expect(route).toContain(
      'D     192.168.3.0/24 [90/3328] via 10.0.12.2, 00:00:02, GigabitEthernet0/1',
    );
    expect(route).toContain(
      'D*EX  0.0.0.0/0 [170/3328] via 10.0.12.2, 00:00:02, GigabitEthernet0/1',
    );
  });
});
