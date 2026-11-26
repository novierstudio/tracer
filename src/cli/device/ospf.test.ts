import { describe, expect, it } from 'vitest';
import type {
  OspfInterfaceState,
  OspfInterfaceStatus,
  OspfNeighborStatus,
  OspfStatus,
  RipStatus,
  RoutingProtocols,
} from '../../engine/api';
import { OSPF_TIMERS, RIP_TIMERS } from '../../engine/routing/timers';
import type { InterfaceId, Ipv4Address, RouterConfig } from '../../model';
import { INVALID_INPUT } from './context';
import { applyLines, withBlankConfig } from './session';
import { runningConfig } from './show';
import { consoleOn, router } from './testing';

const ENTER = ['enable', 'configure terminal'];
const NO_ENGINE = ['% The simulation is not running, so there is no live state to show.'];

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

describe('OSPF show commands', () => {
  const lo0 = 'Loopback0' as InterfaceId;
  const g00 = 'GigabitEthernet0/0' as InterfaceId;
  const g01 = 'GigabitEthernet0/1' as InterfaceId;
  const s000 = 'Serial0/0/0' as InterfaceId;
  const ip = (address: string) => address as Ipv4Address;
  const cidr = (address: string, prefixLength: number) =>
    ({ address, prefixLength }) as OspfInterfaceStatus['cidr'];

  const BASE = {
    area: 0,
    cost: 1,
    priority: 1,
    passive: false,
    dr: undefined,
    bdr: undefined,
    helloDueMs: undefined,
    neighbors: [],
  } as const;

  const LOOPBACK: OspfInterfaceStatus = {
    ...BASE,
    name: lo0,
    cidr: cidr('1.1.1.1', 32),
    networkType: 'loopback',
    state: 'loopback',
  };
  const LAN: OspfInterfaceStatus = {
    ...BASE,
    name: g00,
    cidr: cidr('192.168.1.1', 24),
    networkType: 'broadcast',
    state: 'dr',
    passive: true,
    dr: { routerId: ip('1.1.1.1'), address: ip('192.168.1.1') },
  };
  const TRANSIT: OspfInterfaceStatus = {
    ...BASE,
    name: g01,
    cidr: cidr('10.0.12.1', 24),
    networkType: 'broadcast',
    state: 'dr',
    dr: { routerId: ip('1.1.1.1'), address: ip('10.0.12.1') },
    bdr: { routerId: ip('2.2.2.2'), address: ip('10.0.12.2') },
    helloDueMs: 3_400,
    neighbors: [
      {
        routerId: ip('2.2.2.2'),
        priority: 1,
        state: 'full',
        role: 'bdr',
        deadMs: 33_900,
        address: ip('10.0.12.2'),
        interface: g01,
      },
      {
        routerId: ip('4.4.4.4'),
        priority: 0,
        state: 'exstart',
        role: 'drother',
        deadMs: 38_000,
        address: ip('10.0.12.4'),
        interface: g01,
      },
    ],
  };
  const SERIAL: OspfInterfaceStatus = {
    ...BASE,
    name: s000,
    cidr: cidr('10.0.13.1', 30),
    cost: 64,
    networkType: 'point-to-point',
    state: 'point-to-point',
    helloDueMs: 400,
    neighbors: [
      {
        routerId: ip('3.3.3.3'),
        // Its hellos say 1; IOS shows 0 on a point-to-point link.
        priority: 1,
        state: 'full',
        role: undefined,
        deadMs: 37_200,
        address: ip('10.0.13.3'),
        interface: s000,
      },
    ],
  };

  const STATUS: OspfStatus = {
    processId: 1,
    routerId: ip('1.1.1.1'),
    timers: OSPF_TIMERS.ios,
    interfaces: [LOOPBACK, LAN, TRANSIT, SERIAL],
    sources: [
      { routerId: ip('2.2.2.2'), lastUpdateMs: 72_000 },
      { routerId: ip('3.3.3.3'), lastUpdateMs: 5_000 },
    ],
  };

  const OSPF_LINES = [
    'interface loopback 0',
    'ip address 1.1.1.1 255.255.255.255',
    'interface g0/0',
    'ip address 192.168.1.1 255.255.255.0',
    'router ospf 1',
    'router-id 1.1.1.1',
    'network 192.168.1.0 0.0.0.255 area 0',
    'network 10.0.0.0 0.255.255.255 area 0',
    'passive-interface g0/0',
  ];

  /** Runs `command` after `lines` and answers its query, as a terminal does. */
  function showWith(lines: readonly string[], command: string, answer: RoutingProtocols) {
    const { c } = configured([...lines, 'end']);
    const { output, query } = c.session.run(c.device, command);
    if (query?.kind !== 'protocols') throw new Error(`asked for ${query?.kind}`);
    return { live: query.render(answer), output };
  }

  const both = { eigrp: undefined, rip: undefined, ospf: STATUS };

  describe('show ip protocols', () => {
    it('describes the OSPF process from its config and the simulation', () => {
      expect(showWith(OSPF_LINES, 'show ip protocols', both).live).toEqual([
        'Routing Protocol is "ospf 1"',
        '  Outgoing update filter list for all interfaces is not set',
        '  Incoming update filter list for all interfaces is not set',
        '  Router ID 1.1.1.1',
        '  Number of areas in this router is 1. 1 normal 0 stub 0 nssa',
        '  Maximum path: 4',
        '  Routing for Networks:',
        '    192.168.1.0 0.0.0.255 area 0',
        '    10.0.0.0 0.255.255.255 area 0',
        '  Passive Interface(s):',
        '    GigabitEthernet0/0',
        '  Routing Information Sources:',
        '    Gateway         Distance      Last Update',
        '    2.2.2.2              110      00:01:12',
        '    3.3.3.3              110      00:00:05',
        '  Distance: (default is 110)',
      ]);
    });

    it('counts the distinct areas of the OSPF interfaces', () => {
      const status = { ...STATUS, interfaces: [LOOPBACK, { ...SERIAL, area: 1 }] };
      const live = showWith(OSPF_LINES, 'show ip protocols', {
        eigrp: undefined,
        rip: undefined,
        ospf: status,
      }).live;

      expect(live[4]).toBe('  Number of areas in this router is 2. 2 normal 0 stub 0 nssa');
    });

    it('puts OSPF before RIP with a blank line between', () => {
      const rip: RipStatus = {
        timers: RIP_TIMERS.ios,
        nextUpdateMs: 1_000,
        interfaces: [],
        sources: [],
      };
      const lines = [...OSPF_LINES, 'router rip', 'network 10.0.0.0'];
      const live = showWith(lines, 'show ip protocols', {
        rip,
        ospf: STATUS,
        eigrp: undefined,
      }).live;
      const blank = live.indexOf('');

      expect(live[0]).toBe('Routing Protocol is "ospf 1"');
      expect(live.slice(blank - 1, blank + 2)).toEqual([
        '  Distance: (default is 110)',
        '',
        'Routing Protocol is "rip"',
      ]);
    });
  });

  it('lists every neighbour with its state, role and dead time', () => {
    expect(showWith(OSPF_LINES, 'show ip ospf neighbor', both).live).toEqual([
      '',
      'Neighbor ID     Pri   State           Dead Time   Address         Interface',
      '2.2.2.2           1   FULL/BDR        00:00:33    10.0.12.2       GigabitEthernet0/1',
      '4.4.4.4           0   EXSTART/DROTHER 00:00:38    10.0.12.4       GigabitEthernet0/1',
      '3.3.3.3           0   FULL/  -        00:00:37    10.0.13.3       Serial0/0/0',
    ]);
  });

  it.each<[OspfNeighborStatus['state'], OspfNeighborStatus['role'], string]>([
    ['2way', 'drother', '2WAY/DROTHER'],
    ['init', 'dr', 'INIT/DR'],
    ['exchange', 'bdr', 'EXCHANGE/BDR'],
    ['loading', undefined, 'LOADING/  -'],
  ])('shows a %s neighbour as %s', (state, role, text) => {
    const neighbor = { ...SERIAL.neighbors[0]!, state, role };
    const status = { ...STATUS, interfaces: [{ ...SERIAL, neighbors: [neighbor] }] };
    const live = showWith(OSPF_LINES, 'show ip ospf neighbor', {
      eigrp: undefined,
      rip: undefined,
      ospf: status,
    });

    expect(live.live[2]!.slice(22, 38).trimEnd()).toBe(text);
  });

  it('summarises each interface in a row', () => {
    expect(showWith(OSPF_LINES, 'show ip ospf interface brief', both).live).toEqual([
      'Interface    PID   Area            IP Address/Mask    Cost  State Nbrs F/C',
      'Lo0          1     0               1.1.1.1/32         1     LOOP  0/0',
      'Gi0/0        1     0               192.168.1.1/24     1     DR    0/0',
      'Gi0/1        1     0               10.0.12.1/24       1     DR    1/2',
      'Se0/0/0      1     0               10.0.13.1/30       64    P2P   1/1',
    ]);
  });

  it.each<[OspfInterfaceState, string]>([
    ['backup', 'BDR'],
    ['drother', 'DROTH'],
    ['waiting', 'WAIT'],
  ])('shows a %s interface as %s in the brief', (state, text) => {
    const status = { ...STATUS, interfaces: [{ ...TRANSIT, state }] };
    const live = showWith(OSPF_LINES, 'show ip ospf interface brief', {
      rip: undefined,
      eigrp: undefined,
      ospf: status,
    }).live;

    expect(live[1]!.slice(60, 66).trimEnd()).toBe(text);
  });

  describe('show ip ospf interface', () => {
    it('describes a DR with its BDR, timers and adjacencies', () => {
      expect(showWith(OSPF_LINES, 'show ip ospf interface g0/1', both).live).toEqual([
        'GigabitEthernet0/1 is up, line protocol is up',
        '  Internet Address 10.0.12.1/24, Area 0',
        '  Process ID 1, Router ID 1.1.1.1, Network Type BROADCAST, Cost: 1',
        '  Transmit Delay is 1 sec, State DR, Priority 1',
        '  Designated Router (ID) 1.1.1.1, Interface address 10.0.12.1',
        '  Backup Designated router (ID) 2.2.2.2, Interface address 10.0.12.2',
        '  Timer intervals configured, Hello 10, Dead 40, Wait 40, Retransmit 5',
        '    Hello due in 00:00:03',
        '  Neighbor Count is 2, Adjacent neighbor count is 1',
        '    Adjacent with neighbor 2.2.2.2  (Backup Designated Router)',
        '  Suppress hello for 0 neighbor(s)',
      ]);
    });

    it('says a passive interface sends no hellos and has no BDR', () => {
      expect(showWith(OSPF_LINES, 'show ip ospf interface g0/0', both).live).toEqual([
        'GigabitEthernet0/0 is up, line protocol is up',
        '  Internet Address 192.168.1.1/24, Area 0',
        '  Process ID 1, Router ID 1.1.1.1, Network Type BROADCAST, Cost: 1',
        '  Transmit Delay is 1 sec, State DR, Priority 1',
        '  Designated Router (ID) 1.1.1.1, Interface address 192.168.1.1',
        '  No backup designated router on this network',
        '  Timer intervals configured, Hello 10, Dead 40, Wait 40, Retransmit 5',
        '    No Hellos (Passive interface)',
        '  Neighbor Count is 0, Adjacent neighbor count is 0',
        '  Suppress hello for 0 neighbor(s)',
      ]);
    });

    it('describes a point-to-point link with the timers in use and no DR', () => {
      const timers = { hello: 3, dead: 12, wait: 12, retransmit: 2, spfDelay: 0 };
      const status = { ...STATUS, timers };
      expect(
        showWith(OSPF_LINES, 'show ip ospf interface s0/0/0', {
          eigrp: undefined,
          rip: undefined,
          ospf: status,
        }).live,
      ).toEqual([
        'Serial0/0/0 is up, line protocol is up',
        '  Internet Address 10.0.13.1/30, Area 0',
        '  Process ID 1, Router ID 1.1.1.1, Network Type POINT_TO_POINT, Cost: 64',
        '  Transmit Delay is 1 sec, State POINT_TO_POINT',
        '  Timer intervals configured, Hello 3, Dead 12, Wait 12, Retransmit 2',
        '    Hello due in 00:00:00',
        '  Neighbor Count is 1, Adjacent neighbor count is 1',
        '    Adjacent with neighbor 3.3.3.3',
        '  Suppress hello for 0 neighbor(s)',
      ]);
    });

    it('treats a loopback as a stub host', () => {
      expect(showWith(OSPF_LINES, 'show ip ospf interface lo0', both).live).toEqual([
        'Loopback0 is up, line protocol is up',
        '  Internet Address 1.1.1.1/32, Area 0',
        '  Process ID 1, Router ID 1.1.1.1, Network Type LOOPBACK, Cost: 1',
        '  Loopback interface is treated as a stub Host',
      ]);
    });

    it('says when a waiting interface has elected no DR yet', () => {
      const waiting = { ...TRANSIT, state: 'waiting', dr: undefined, bdr: undefined } as const;
      const status = { ...STATUS, interfaces: [waiting] };
      const live = showWith(OSPF_LINES, 'show ip ospf interface', {
        rip: undefined,
        eigrp: undefined,
        ospf: status,
      }).live;

      expect(live.slice(3, 6)).toEqual([
        '  Transmit Delay is 1 sec, State WAITING, Priority 1',
        '  No designated router on this network',
        '  No backup designated router on this network',
      ]);
    });

    it('lists every OSPF interface without a name', () => {
      const live = showWith(OSPF_LINES, 'show ip ospf interface', both).live;

      expect(live.filter((line) => line.includes('line protocol'))).toEqual([
        'Loopback0 is up, line protocol is up',
        'GigabitEthernet0/0 is up, line protocol is up',
        'GigabitEthernet0/1 is up, line protocol is up',
        'Serial0/0/0 is up, line protocol is up',
      ]);
    });

    it('says when the named interface does not run OSPF', () => {
      expect(showWith(OSPF_LINES, 'show ip ospf interface s0/0/1', both).live).toEqual([
        '%OSPF: OSPF not enabled on Serial0/0/1',
      ]);
    });

    it('refuses an interface the router lacks', () => {
      const { c } = configured(['end']);

      expect(c.run('show ip ospf interface g0/9')).toEqual([INVALID_INPUT]);
    });
  });

  it.each(['show ip ospf neighbor', 'show ip ospf interface', 'show ip ospf interface brief'])(
    '%s says the process is not running without a router ID',
    (command) => {
      const status = { ...STATUS, routerId: undefined, interfaces: [] };

      expect(
        showWith(['router ospf 9'], command, { eigrp: undefined, rip: undefined, ospf: status })
          .live,
      ).toEqual(['%OSPF: Router process 1 is not running, please configure a router-id']);
    },
  );

  it.each([
    'show ip protocols',
    'show ip ospf neighbor',
    'show ip ospf interface',
    'show ip ospf interface brief',
  ])('%s prints nothing without OSPF and NO_ENGINE without a simulation', (command) => {
    expect(
      showWith([], command, { eigrp: undefined, rip: undefined, ospf: undefined }).live,
    ).toEqual([]);
    expect(showWith(OSPF_LINES, command, both).output).toEqual(NO_ENGINE);
  });

  it('lists the OSPF show commands with ?', () => {
    const { c } = configured(['end']);

    expect(c.session.help(c.device, 'show ip ospf ')).toEqual([
      '  interface  Interface information',
      '  neighbor   Neighbor list',
    ]);
    expect(c.session.help(c.device, 'show ip ospf interface ')).toEqual(
      expect.arrayContaining([
        '  brief            Brief summary of OSPF interface information',
        '  GigabitEthernet  GigabitEthernet IEEE 802.3z',
      ]),
    );
    expect(c.session.help(c.device, 'show ip ')).toContainEqual(
      expect.stringMatching(/^ {2}ospf +OSPF information$/),
    );
  });
});
