import { describe, expect, it } from 'vitest';
import type { RipStatus, RoutingProtocols } from '../../engine/api';
import { RIP_TIMERS } from '../../engine/routing/timers';
import type { InterfaceId, Ipv4Address, RouterConfig } from '../../model';
import { INVALID_INPUT } from './context';
import { applyLines, withBlankConfig } from './session';
import { runningConfig } from './show';
import { consoleOn, router, switchDevice } from './testing';

const ENTER = ['enable', 'configure terminal'];
const NO_ENGINE = ['% The simulation is not running, so there is no live state to show.'];

/** Runs `lines` from global config on a new router and returns its console. */
function configured(lines: readonly string[]) {
  const c = consoleOn(router());
  const output = c.runAll([...ENTER, ...lines]).slice(1);
  return { c, output, rip: (c.device.config as RouterConfig).rip };
}

const RIP_DEFAULTS = {
  networks: [],
  autoSummary: true,
  passiveInterfaces: [],
  defaultOriginate: false,
};

describe('router rip', () => {
  it('enters RIP config with the defaults, and router rip again keeps what is set', () => {
    const { c, rip } = configured(['router rip']);

    expect(rip).toEqual(RIP_DEFAULTS);
    expect(c.prompt).toBe('Router(config-router)#');
    c.runAll(['version 2', 'exit']);
    expect(c.prompt).toBe('Router(config)#');
    c.run('router rip');
    expect((c.device.config as RouterConfig).rip?.version).toBe(2);
  });

  it('is removed by no router rip', () => {
    expect(configured(['router rip', 'network 10.0.0.0', 'exit', 'no router rip']).rip).toBe(
      undefined,
    );
  });

  it.each<[string, string[], object]>([
    ['version 2', ['version 2'], { version: 2 }],
    ['version 1', ['version 1'], { version: 1 }],
    ['no version', ['version 2', 'no version'], { version: undefined }],
    ['network, as its classful network', ['network 10.1.1.0'], { networks: ['10.0.0.0'] }],
    [
      'networks, sorted with no duplicates',
      ['network 192.168.1.0', 'network 172.16.4.0', 'network 10.9.0.0', 'network 10.0.0.0'],
      { networks: ['10.0.0.0', '172.16.0.0', '192.168.1.0'] },
    ],
    [
      'no network',
      ['network 10.0.0.0', 'network 192.168.1.0', 'no network 10.2.0.0'],
      { networks: ['192.168.1.0'] },
    ],
    [
      'no network that is absent',
      ['network 10.0.0.0', 'no network 11.0.0.0'],
      { networks: ['10.0.0.0'] },
    ],
    ['no auto-summary', ['no auto-summary'], { autoSummary: false }],
    ['auto-summary', ['no auto-summary', 'auto-summary'], { autoSummary: true }],
    [
      'passive interfaces, in interface order',
      ['passive-interface s0/0/0', 'passive-interface g0/1', 'passive-interface s0/0/0'],
      { passiveInterfaces: ['GigabitEthernet0/1', 'Serial0/0/0'] },
    ],
    [
      'no passive-interface',
      ['passive-interface g0/0', 'passive-interface g0/1', 'no passive-interface g0/0'],
      { passiveInterfaces: ['GigabitEthernet0/1'] },
    ],
    [
      'default-information originate',
      ['default-information originate'],
      { defaultOriginate: true },
    ],
    [
      'no default-information originate',
      ['default-information originate', 'no default-information originate'],
      { defaultOriginate: false },
    ],
  ])('sets %s', (_name, lines, expected) => {
    const { rip, output } = configured(['router rip', ...lines]);

    expect(output).toEqual([]);
    expect(rip).toEqual({ ...RIP_DEFAULTS, ...expected });
  });

  it('drops a passive subinterface when the subinterface is removed', () => {
    const { rip } = configured([
      'interface g0/0.10',
      'router rip',
      'passive-interface g0/0.10',
      'exit',
      'no interface g0/0.10',
    ]);

    expect(rip?.passiveInterfaces).toEqual([]);
  });

  it.each<[string, string[], readonly string[]]>([
    ['a class D network', ['network 224.0.0.9'], [INVALID_INPUT]],
    ['a class E network', ['network 240.0.0.0'], [INVALID_INPUT]],
    ['a passive interface the router lacks', ['passive-interface g0/9'], [INVALID_INPUT]],
    ['no network without an address', ['no network'], ['% Incomplete command.']],
  ])('refuses %s', (_name, lines, expected) => {
    const { c } = configured(['router rip', ...lines.slice(0, -1)]);
    const before = c.device;

    expect(c.run(lines.at(-1)!)).toEqual(expected);
    expect(c.device).toBe(before);
  });

  it('lists its commands with ?', () => {
    const { c } = configured(['router rip']);

    expect(c.session.help(c.device, '')).toEqual([
      '  auto-summary         Enable automatic network number summarization',
      '  default-information  Control distribution of default information',
      '  do                   To run exec commands in config mode',
      '  end                  Exit from configure mode',
      '  exit                 Exit from configure mode',
      '  network              Enable routing on an IP network',
      '  no                   Negate a command or set its defaults',
      '  passive-interface    Suppress routing updates on an interface',
      '  version              Set routing protocol version',
    ]);
    expect(c.session.help(c.device, 'version ')).toEqual(['  <1-2>  version']);
    expect(c.session.help(c.device, 'network ')).toEqual(['  A.B.C.D  Network number']);
    expect(c.session.help(c.device, 'default-information ')).toEqual([
      '  originate  Distribute a default route',
    ]);
  });

  it('is offered under router in global config', () => {
    const { c } = configured([]);

    expect(c.session.help(c.device, 'router ')).toEqual([
      '  rip  Routing Information Protocol (RIP)',
    ]);
  });
});

describe('router rip in the running-config', () => {
  const full = [
    'interface g0/0',
    'ip address 192.168.1.1 255.255.255.0',
    'interface s0/0/0',
    'ip address 10.0.12.1 255.255.255.252',
    'exit',
    'ip route 0.0.0.0 0.0.0.0 10.0.12.2',
    'router rip',
    'version 2',
    'network 192.168.1.0',
    'network 10.0.12.0',
    'passive-interface g0/0',
    'default-information originate',
    'no auto-summary',
  ];

  it('comes after the interfaces and before the static routes, every setting in IOS order', () => {
    const lines = runningConfig(configured(full).c.device);
    const start = lines.indexOf('router rip');

    expect(lines.slice(start - 1, start + 10)).toEqual([
      '!',
      'router rip',
      ' version 2',
      ' passive-interface GigabitEthernet0/0',
      ' network 10.0.0.0',
      ' network 192.168.1.0',
      ' default-information originate',
      ' no auto-summary',
      '!',
      'ip route 0.0.0.0 0.0.0.0 10.0.12.2',
      '!',
    ]);
    expect(lines.indexOf('interface Serial0/0/1')).toBeLessThan(start);
  });

  it('prints only router rip for the defaults, and nothing without RIP', () => {
    const lines = runningConfig(configured(['router rip']).c.device);
    const start = lines.indexOf('router rip');

    expect(lines.slice(start, start + 2)).toEqual(['router rip', '!']);
    expect(runningConfig(router())).not.toContain('router rip');
  });

  it.each<[string, string[]]>([
    ['every setting', full],
    ['the defaults', ['router rip']],
    ['version 1 with auto-summary', ['router rip', 'version 1', 'network 172.16.0.0']],
  ])('rebuilds %s on a blank router', (_name, lines) => {
    const device = configured(lines).c.device;

    const { config, errors } = applyLines(withBlankConfig(device), runningConfig(device));

    expect(errors).toEqual([]);
    expect(config).toEqual(device.config);
  });
});

describe('show ip protocols', () => {
  const g00 = 'GigabitEthernet0/0' as InterfaceId;
  const g01 = 'GigabitEthernet0/1' as InterfaceId;
  const s000 = 'Serial0/0/0' as InterfaceId;

  const STATUS: RipStatus = {
    timers: RIP_TIMERS.ios,
    nextUpdateMs: 11_200,
    interfaces: [g01, s000],
    sources: [{ gateway: '10.0.0.2' as Ipv4Address, lastUpdateMs: 5_900 }],
  };

  /** Runs `show ip protocols` after `lines` and answers its query, as a terminal does. */
  function showWith(lines: readonly string[], answer: RoutingProtocols) {
    const { c } = configured([...lines, 'end']);
    const { output, query } = c.session.run(c.device, 'show ip protocols');
    if (query?.kind !== 'protocols') throw new Error(`asked for ${query?.kind}`);
    return { live: query.render(answer), output };
  }

  const v2 = [
    'router rip',
    'version 2',
    'network 10.0.0.0',
    'network 192.168.1.0',
    'passive-interface g0/0',
    'no auto-summary',
  ];

  it('describes the RIP process from its config and the simulation', () => {
    expect(showWith(v2, { rip: STATUS }).live).toEqual([
      'Routing Protocol is "rip"',
      '  Outgoing update filter list for all interfaces is not set',
      '  Incoming update filter list for all interfaces is not set',
      '  Sending updates every 30 seconds, next due in 12 seconds',
      '  Invalid after 180 seconds, hold down 180, flushed after 240',
      '  Redistributing: rip',
      '  Default version control: send version 2, receive version 2',
      '    Interface             Send  Recv  Triggered RIP  Key-chain',
      '    GigabitEthernet0/1    2     2',
      '    Serial0/0/0           2     2',
      '  Automatic network summarization is not in effect',
      '  Maximum path: 4',
      '  Routing for Networks:',
      '    10.0.0.0',
      '    192.168.1.0',
      '  Passive Interface(s):',
      `    ${g00}`,
      '  Routing Information Sources:',
      '    Gateway         Distance      Last Update',
      '    10.0.0.2             120      00:00:05',
      '  Distance: (default is 120)',
    ]);
  });

  it('sends v1 and receives either version when no version is set', () => {
    const live = showWith(['router rip', 'network 10.0.0.0'], {
      rip: { ...STATUS, timers: RIP_TIMERS.fast, nextUpdateMs: 3_000, sources: [] },
    }).live;

    expect(live.slice(3, 10)).toEqual([
      '  Sending updates every 5 seconds, next due in 3 seconds',
      '  Invalid after 15 seconds, hold down 15, flushed after 20',
      '  Redistributing: rip',
      '  Default version control: send version 1, receive any version',
      '    Interface             Send  Recv  Triggered RIP  Key-chain',
      '    GigabitEthernet0/1    1     1 2',
      '    Serial0/0/0           1     1 2',
    ]);
    expect(live.slice(10)).toEqual([
      '  Automatic network summarization is in effect',
      '  Maximum path: 4',
      '  Routing for Networks:',
      '    10.0.0.0',
      '  Routing Information Sources:',
      '    Gateway         Distance      Last Update',
      '  Distance: (default is 120)',
    ]);
  });

  it('pins both directions to version 1', () => {
    const live = showWith(['router rip', 'version 1'], { rip: STATUS }).live;

    expect(live.slice(6, 9)).toEqual([
      '  Default version control: send version 1, receive version 1',
      '    Interface             Send  Recv  Triggered RIP  Key-chain',
      '    GigabitEthernet0/1    1     1',
    ]);
  });

  it('prints nothing when no routing protocol is configured', () => {
    expect(showWith([], { rip: undefined }).live).toEqual([]);
  });

  it('says there is no live state without a simulation', () => {
    expect(showWith(v2, { rip: STATUS }).output).toEqual(NO_ENGINE);
  });

  it('is a router command only', () => {
    const c = consoleOn(switchDevice());
    c.run('enable');
    expect(c.run('show ip protocols')).toContain(INVALID_INPUT);
  });
});
