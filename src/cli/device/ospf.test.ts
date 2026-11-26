import { describe, expect, it } from 'vitest';
import type { RouterConfig } from '../../model';
import { INVALID_INPUT } from './context';
import { applyLines, withBlankConfig } from './session';
import { runningConfig } from './show';
import { consoleOn, router } from './testing';

const ENTER = ['enable', 'configure terminal'];

/** Runs `lines` from global config on a new router and returns its console. */
function configured(lines: readonly string[]) {
  const c = consoleOn(router());
  const output = c.runAll([...ENTER, ...lines]).slice(1);
  const config = () => c.device.config as RouterConfig;
  return { c, output, ospf: config().ospf, config };
}

const OSPF_DEFAULTS = { processId: 1, networks: [], passiveInterfaces: [] };

describe('router ospf', () => {
  it('enters OSPF config with no networks, and router ospf again keeps what is set', () => {
    const { c, ospf, config } = configured(['router ospf 1']);

    expect(ospf).toEqual(OSPF_DEFAULTS);
    expect(c.prompt).toBe('Router(config-router)#');
    c.runAll(['router-id 1.1.1.1', 'exit']);
    expect(c.prompt).toBe('Router(config)#');
    c.run('router ospf 1');
    expect(config().ospf?.routerId).toBe('1.1.1.1');
  });

  it('refuses a second process, and stays in global config', () => {
    const { c, config } = configured([
      'router ospf 7',
      'network 10.0.0.0 0.0.0.255 area 0',
      'exit',
    ]);

    expect(c.run('router ospf 8')).toEqual([
      '% Tracer runs one OSPF process per router. Remove router ospf 7 first.',
    ]);
    expect(c.prompt).toBe('Router(config)#');
    expect(config().ospf?.processId).toBe(7);
  });

  it('is removed by no router ospf with its number, and kept for another number', () => {
    const lines = ['router ospf 1', 'network 10.0.0.0 0.0.0.255 area 0', 'exit'];

    expect(configured([...lines, 'no router ospf 2']).ospf?.processId).toBe(1);
    expect(configured([...lines, 'no router ospf 1']).ospf).toBe(undefined);
  });

  it.each<[string, string[], object]>([
    ['router-id', ['router-id 1.1.1.1'], { routerId: '1.1.1.1' }],
    ['no router-id', ['router-id 1.1.1.1', 'no router-id'], {}],
    [
      'networks, in the order entered',
      ['network 192.168.1.0 0.0.0.255 area 0', 'network 10.0.12.0 0.0.0.3 area 1'],
      {
        networks: [
          { address: '192.168.1.0', wildcard: '0.0.0.255', area: 0 },
          { address: '10.0.12.0', wildcard: '0.0.0.3', area: 1 },
        ],
      },
    ],
    [
      'a network with its wildcard bits cleared',
      ['network 192.168.1.77 0.0.0.255 area 0'],
      { networks: [{ address: '192.168.1.0', wildcard: '0.0.0.255', area: 0 }] },
    ],
    [
      'a non-contiguous wildcard',
      ['network 10.0.0.0 0.255.0.255 area 4294967295'],
      { networks: [{ address: '10.0.0.0', wildcard: '0.255.0.255', area: 4294967295 }] },
    ],
    [
      'a network again, replacing its area in place',
      [
        'network 10.0.0.0 0.0.0.255 area 0',
        'network 10.0.1.0 0.0.0.255 area 0',
        'network 10.0.0.0 0.0.0.255 area 2',
      ],
      {
        networks: [
          { address: '10.0.0.0', wildcard: '0.0.0.255', area: 2 },
          { address: '10.0.1.0', wildcard: '0.0.0.255', area: 0 },
        ],
      },
    ],
    [
      'no network',
      [
        'network 10.0.0.0 0.0.0.255 area 0',
        'network 10.0.1.0 0.0.0.255 area 0',
        'no network 10.0.0.0 0.0.0.255 area 0',
      ],
      { networks: [{ address: '10.0.1.0', wildcard: '0.0.0.255', area: 0 }] },
    ],
    [
      'no network in another area, which keeps it',
      ['network 10.0.0.0 0.0.0.255 area 0', 'no network 10.0.0.0 0.0.0.255 area 1'],
      { networks: [{ address: '10.0.0.0', wildcard: '0.0.0.255', area: 0 }] },
    ],
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
  ])('sets %s', (_name, lines, expected) => {
    const { ospf, output } = configured(['router ospf 1', ...lines]);

    expect(output).toEqual([]);
    expect(ospf).toEqual({ ...OSPF_DEFAULTS, ...expected });
  });

  it.each(['g0/0.10', 'loopback 0'])('drops passive %s when it is removed', (name) => {
    const { ospf } = configured([
      `interface ${name}`,
      'router ospf 1',
      `passive-interface ${name}`,
      'exit',
      `no interface ${name}`,
    ]);

    expect(ospf?.passiveInterfaces).toEqual([]);
  });

  it.each<[string, string[], readonly string[]]>([
    ['a passive interface the router lacks', ['passive-interface g0/9'], [INVALID_INPUT]],
    ['no network without its area', ['no network 10.0.0.0 0.0.0.255'], ['% Incomplete command.']],
    ['no passive-interface without a name', ['no passive-interface'], ['% Incomplete command.']],
  ])('refuses %s', (_name, lines, expected) => {
    const { c } = configured(['router ospf 1', ...lines.slice(0, -1)]);
    const before = c.device;

    expect(c.run(lines.at(-1)!)).toEqual(expected);
    expect(c.device).toBe(before);
  });

  it('refuses no router ospf without a number', () => {
    const { c } = configured(['router ospf 1', 'exit']);
    const before = c.device;

    expect(c.run('no router ospf')).toEqual(['% Incomplete command.']);
    expect(c.device).toBe(before);
  });

  it('leaves log-adjacency-changes unknown', () => {
    const { c } = configured(['router ospf 1']);

    expect(c.run('log-adjacency-changes')).toContain(INVALID_INPUT);
  });

  it('lists its commands with ?', () => {
    const { c } = configured(['router ospf 1']);

    expect(c.session.help(c.device, '')).toEqual([
      '  do                 To run exec commands in config mode',
      '  end                Exit from configure mode',
      '  exit               Exit from configure mode',
      '  network            Enable routing on an IP network',
      '  no                 Negate a command or set its defaults',
      '  passive-interface  Suppress routing updates on an interface',
      '  router-id          router-id for this OSPF process',
    ]);
    expect(c.session.help(c.device, 'router-id ')).toEqual([
      '  A.B.C.D  OSPF router-id in IP address format',
    ]);
    expect(c.session.help(c.device, 'network ')).toEqual(['  A.B.C.D  Network number']);
    expect(c.session.help(c.device, 'network 10.0.0.0 ')).toEqual([
      '  A.B.C.D  OSPF wild card bits',
    ]);
    expect(c.session.help(c.device, 'network 10.0.0.0 0.0.0.255 ')).toEqual([
      '  area  Set the OSPF area ID',
    ]);
    expect(c.session.help(c.device, 'network 10.0.0.0 0.0.0.255 area ')).toEqual([
      '  <0-4294967295>  OSPF area ID as a decimal value',
    ]);
  });

  it('is offered under router in global config', () => {
    const { c } = configured([]);

    expect(c.session.help(c.device, 'router ')).toEqual([
      '  ospf  Open Shortest Path First (OSPF)',
      '  rip   Routing Information Protocol (RIP)',
    ]);
    expect(c.session.help(c.device, 'router ospf ')).toEqual(['  <1-65535>  Process ID']);
  });
});

describe('ip ospf on an interface', () => {
  it.each<[string, string, string[], object]>([
    ['cost', 'interface g0/0', ['ip ospf cost 10'], { ospfCost: 10 }],
    ['no cost', 'interface g0/0', ['ip ospf cost 10', 'no ip ospf cost'], {}],
    ['priority', 'interface g0/0', ['ip ospf priority 0'], { ospfPriority: 0 }],
    ['no priority', 'interface g0/0', ['ip ospf priority 9', 'no ip ospf priority'], {}],
    ['cost on a loopback', 'interface loopback 0', ['ip ospf cost 5'], { ospfCost: 5 }],
  ])('sets %s', (_name, enter, lines, expected) => {
    const { config, output } = configured([enter, ...lines]);
    const name = enter === 'interface g0/0' ? 'GigabitEthernet0/0' : 'Loopback0';
    const target = config().interfaces[name as never] ?? config().virtualInterfaces[name as never];

    expect(output).toEqual([]);
    expect({ ospfCost: target?.ospfCost, ospfPriority: target?.ospfPriority }).toEqual({
      ospfCost: undefined,
      ospfPriority: undefined,
      ...expected,
    });
  });

  it('sets every interface of a range', () => {
    const { config } = configured([
      'interface range g0/0 - 1',
      'ip ospf cost 7',
      'ip ospf priority 3',
    ]);

    for (const name of ['GigabitEthernet0/0', 'GigabitEthernet0/1']) {
      expect(config().interfaces[name as never]).toMatchObject({ ospfCost: 7, ospfPriority: 3 });
    }
  });

  it('sets a subinterface', () => {
    const { config } = configured(['interface g0/0.10', 'ip ospf cost 20', 'ip ospf priority 200']);

    expect(config().subinterfaces['GigabitEthernet0/0.10' as never]).toEqual({
      shutdown: false,
      ospfCost: 20,
      ospfPriority: 200,
    });
  });

  it.each(['ip ospf cost 0', 'ip ospf cost 65536', 'ip ospf priority 256'])(
    'refuses %s',
    (line) => {
      const { c } = configured(['interface g0/0']);

      expect(c.run(line)).toContain(INVALID_INPUT);
    },
  );

  it('lists the OSPF interface commands with ?', () => {
    const { c } = configured(['interface g0/0']);

    expect(c.session.help(c.device, 'ip ospf ')).toEqual([
      '  cost      Interface cost',
      '  priority  Router priority',
    ]);
    expect(c.session.help(c.device, 'ip ospf cost ')).toEqual(['  <1-65535>  Cost']);
    expect(c.session.help(c.device, 'ip ospf priority ')).toEqual(['  <0-255>  Priority']);
  });
});

describe('OSPF in the running-config', () => {
  const full = [
    'interface loopback 0',
    'ip address 1.1.1.1 255.255.255.255',
    'interface g0/0',
    'ip address 192.168.1.1 255.255.255.0',
    'ip ospf cost 10',
    'ip ospf priority 0',
    'interface s0/0/0',
    'ip address 10.0.12.1 255.255.255.252',
    'ip ospf cost 64',
    'exit',
    'router ospf 1',
    'router-id 1.1.1.1',
    'network 192.168.1.0 0.0.0.255 area 0',
    'network 10.0.12.0 0.0.0.3 area 0',
    'passive-interface g0/0',
    'exit',
    'router rip',
    'network 10.0.0.0',
  ];

  it('prints the interface costs after the address and the process before router rip', () => {
    const lines = runningConfig(configured(full).c.device);
    const g00 = lines.indexOf('interface GigabitEthernet0/0');
    const start = lines.indexOf('router ospf 1');

    expect(lines.slice(g00, g00 + 4)).toEqual([
      'interface GigabitEthernet0/0',
      ' ip address 192.168.1.1 255.255.255.0',
      ' ip ospf cost 10',
      ' ip ospf priority 0',
    ]);
    expect(lines.slice(start - 1, start + 8)).toEqual([
      '!',
      'router ospf 1',
      ' router-id 1.1.1.1',
      ' passive-interface GigabitEthernet0/0',
      ' network 192.168.1.0 0.0.0.255 area 0',
      ' network 10.0.12.0 0.0.0.3 area 0',
      '!',
      'router rip',
      ' network 10.0.0.0',
    ]);
  });

  it('prints only router ospf for an empty process, and nothing without OSPF', () => {
    const lines = runningConfig(configured(['router ospf 42']).c.device);
    const start = lines.indexOf('router ospf 42');

    expect(lines.slice(start, start + 2)).toEqual(['router ospf 42', '!']);
    expect(runningConfig(router()).join('\n')).not.toContain('ospf');
  });

  it.each<[string, string[]]>([
    ['every setting', full],
    ['an empty process', ['router ospf 42']],
    ['a subinterface cost', ['interface g0/0.10', 'encapsulation dot1Q 10', 'ip ospf cost 3']],
  ])('rebuilds %s on a blank router', (_name, lines) => {
    const device = configured(lines).c.device;

    const { config, errors } = applyLines(withBlankConfig(device), runningConfig(device));

    expect(errors).toEqual([]);
    expect(config).toEqual(device.config);
  });
});
