import { describe, expect, it } from 'vitest';
import type { ArpTableEntry, MacTableEntry, Route } from '../../engine/api';
import type { EngineAnswers, EngineQueryKind } from './query';
import { consoleOn, router, switchDevice } from './testing';

const ENTER = ['enable', 'configure terminal'];
const NO_ENGINE = ['% The simulation is not running, so there is no live state to show.'];

const cidr = (address: string, prefixLength: number) => ({ address, prefixLength });

/**
 * Runs a show command and answers its query with `answer`, as a terminal does with the
 * simulation's reply. Also returns what it prints with no simulation to ask.
 */
function showWith<K extends EngineQueryKind>(
  c: ReturnType<typeof consoleOn>,
  line: string,
  kind: K,
  answer: EngineAnswers[K],
) {
  const { output, query } = c.session.run(c.device, line);
  if (query?.kind !== kind) throw new Error(`${line} asked for ${query?.kind}, not ${kind}`);
  return { live: (query.render as (a: EngineAnswers[K]) => readonly string[])(answer), output };
}

const LEGEND = [
  'Codes: L - local, C - connected, S - static, R - RIP, M - mobile, B - BGP',
  '       D - EIGRP, EX - EIGRP external, O - OSPF, IA - OSPF inter area',
  '       N1 - OSPF NSSA external type 1, N2 - OSPF NSSA external type 2',
  '       E1 - OSPF external type 1, E2 - OSPF external type 2, E - EGP',
  '       i - IS-IS, L1 - IS-IS level-1, L2 - IS-IS level-2, ia - IS-IS inter area',
  '       * - candidate default, U - per-user static route, o - ODR',
  '       P - periodic downloaded static route',
];

describe('show ip route', () => {
  it('lists the router-on-a-stick subnets under their classful networks', () => {
    const routes = [
      { source: 'connected', prefix: cidr('192.168.10.0', 24), interface: 'GigabitEthernet0/0.10' },
      { source: 'local', prefix: cidr('192.168.10.1', 32), interface: 'GigabitEthernet0/0.10' },
      { source: 'connected', prefix: cidr('192.168.20.0', 24), interface: 'GigabitEthernet0/0.20' },
      { source: 'local', prefix: cidr('192.168.20.1', 32), interface: 'GigabitEthernet0/0.20' },
    ] as Route[];

    const { live } = showWith(consoleOn(router()), 'show ip route', 'routes', routes);

    expect(live).toEqual([
      ...LEGEND,
      '',
      'Gateway of last resort is not set',
      '',
      '      192.168.10.0/24 is variably subnetted, 2 subnets, 2 masks',
      'C        192.168.10.0/24 is directly connected, GigabitEthernet0/0.10',
      'L        192.168.10.1/32 is directly connected, GigabitEthernet0/0.10',
      '      192.168.20.0/24 is variably subnetted, 2 subnets, 2 masks',
      'C        192.168.20.0/24 is directly connected, GigabitEthernet0/0.20',
      'L        192.168.20.1/32 is directly connected, GigabitEthernet0/0.20',
    ]);
  });

  it('names the gateway of last resort and marks the static default as a candidate', () => {
    const routes = [
      {
        source: 'static',
        prefix: cidr('0.0.0.0', 0),
        distance: 1,
        nextHop: { kind: 'address', address: '10.0.0.2' },
      },
      { source: 'connected', prefix: cidr('10.0.0.0', 30), interface: 'Serial0/0/0' },
      { source: 'local', prefix: cidr('10.0.0.1', 32), interface: 'Serial0/0/0' },
      {
        source: 'static',
        prefix: cidr('172.16.0.0', 16),
        distance: 1,
        nextHop: { kind: 'interface', interface: 'Serial0/0/0' },
      },
      {
        source: 'static',
        prefix: cidr('172.20.1.0', 24),
        distance: 5,
        nextHop: { kind: 'address', address: '10.0.0.2' },
      },
    ] as Route[];

    const { live } = showWith(consoleOn(router()), 'show ip route', 'routes', routes);

    expect(live.slice(LEGEND.length)).toEqual([
      '',
      'Gateway of last resort is 10.0.0.2 to network 0.0.0.0',
      '',
      'S*    0.0.0.0/0 [1/0] via 10.0.0.2',
      '      10.0.0.0/8 is variably subnetted, 2 subnets, 2 masks',
      'C        10.0.0.0/30 is directly connected, Serial0/0/0',
      'L        10.0.0.1/32 is directly connected, Serial0/0/0',
      'S     172.16.0.0/16 is directly connected, Serial0/0/0',
      '      172.20.0.0/24 is subnetted, 1 subnets',
      'S        172.20.1.0/24 [5/0] via 10.0.0.2',
    ]);
  });

  it('gives learned routes their distance, metric, next hop, age and interface, one line per path', () => {
    const learned = (source: 'rip' | 'ospf', prefix: ReturnType<typeof cidr>, via: string) => ({
      source,
      prefix,
      distance: source === 'rip' ? 120 : 110,
      metric: source === 'rip' ? 1 : 65,
      via,
      interface: via.startsWith('10.0.12') ? 'GigabitEthernet0/1' : 'Serial0/0/0',
      ageMs: 83_400,
    });
    const routes = [
      { ...learned('rip', cidr('0.0.0.0', 0), '10.0.13.3'), ageMs: 4_000 },
      { source: 'connected', prefix: cidr('10.0.12.0', 30), interface: 'GigabitEthernet0/1' },
      { source: 'local', prefix: cidr('10.0.12.1', 32), interface: 'GigabitEthernet0/1' },
      learned('ospf', cidr('192.168.3.0', 24), '10.0.12.2'),
      learned('ospf', cidr('192.168.3.0', 24), '10.0.13.3'),
      {
        ...learned('ospf', cidr('192.168.4.0', 24), '10.0.13.3'),
        ageMs: 2 * 86_400_000 + 3_600_000,
      },
    ] as Route[];

    const { live } = showWith(consoleOn(router()), 'show ip route', 'routes', routes);

    expect(live.slice(LEGEND.length)).toEqual([
      '',
      'Gateway of last resort is 10.0.13.3 to network 0.0.0.0',
      '',
      'R*    0.0.0.0/0 [120/1] via 10.0.13.3, 00:00:04, Serial0/0/0',
      '      10.0.0.0/8 is variably subnetted, 2 subnets, 2 masks',
      'C        10.0.12.0/30 is directly connected, GigabitEthernet0/1',
      'L        10.0.12.1/32 is directly connected, GigabitEthernet0/1',
      'O     192.168.3.0/24 [110/65] via 10.0.12.2, 00:01:23, GigabitEthernet0/1',
      '                     [110/65] via 10.0.13.3, 00:01:23, Serial0/0/0',
      'O     192.168.4.0/24 [110/65] via 10.0.13.3, 2d01h, Serial0/0/0',
    ]);
  });

  it('says there is no live state without a simulation', () => {
    const { output } = showWith(consoleOn(router()), 'show ip route', 'routes', []);

    expect(output).toEqual(NO_ENGINE);
  });

  it("gives a switch's default gateway from its config", () => {
    const c = consoleOn(switchDevice());
    c.runAll([...ENTER, 'ip default-gateway 192.168.1.1', 'end']);

    expect(c.run('show ip route')).toEqual([
      'Default gateway is 192.168.1.1',
      '',
      'Host               Gateway           Last Use    Total Uses  Interface',
      'ICMP redirect cache is empty',
    ]);
  });
});

describe('show arp', () => {
  const entries = [
    {
      kind: 'interface',
      address: '192.168.10.1',
      mac: '00:01:42:a9:0b:01',
      interface: 'GigabitEthernet0/0.10',
    },
    {
      kind: 'dynamic',
      address: '192.168.10.10',
      mac: '00:60:2f:84:4a:b6',
      interface: 'GigabitEthernet0/0.10',
      ageMs: 185_000,
    },
  ] as ArpTableEntry[];

  it.each(['show arp', 'show ip arp'])('%s lists own addresses with no age', (line) => {
    const { live } = showWith(consoleOn(router()), line, 'arp', entries);

    expect(live).toEqual([
      'Protocol  Address          Age (min)  Hardware Addr   Type   Interface',
      'Internet  192.168.10.1            -   0001.42a9.0b01  ARPA   GigabitEthernet0/0.10',
      'Internet  192.168.10.10           3   0060.2f84.4ab6  ARPA   GigabitEthernet0/0.10',
    ]);
  });
});

describe('show mac address-table', () => {
  const entries = [
    { vlan: 1, mac: '00:01:64:76:12:01', port: 'GigabitEthernet0/1' },
    { vlan: 10, mac: '00:60:47:c5:9e:01', port: 'FastEthernet0/1' },
    { vlan: 10, mac: '00:d0:ba:11:22:33', port: 'GigabitEthernet0/1' },
  ] as MacTableEntry[];

  it.each(['show mac address-table', 'show mac-address-table'])('%s', (line) => {
    const { live } = showWith(consoleOn(switchDevice()), line, 'macTable', entries);

    expect(live).toEqual([
      '          Mac Address Table',
      '-------------------------------------------',
      '',
      'Vlan    Mac Address       Type        Ports',
      '----    -----------       --------    -----',
      '',
      '   1    0001.6476.1201    DYNAMIC     Gi0/1',
      '  10    0060.47c5.9e01    DYNAMIC     Fa0/1',
      '  10    00d0.ba11.2233    DYNAMIC     Gi0/1',
      'Total Mac Addresses for this criterion: 3',
    ]);
  });

  it('is a switch command only', () => {
    const c = consoleOn(router());
    c.run('enable');

    expect(c.run('show mac address-table').at(-1)).toBe("% Invalid input detected at '^' marker.");
  });
});

function trunkSwitch() {
  const c = consoleOn(
    switchDevice(['FastEthernet0/1', 'FastEthernet0/2', 'FastEthernet0/3', 'GigabitEthernet0/1']),
  );
  c.runAll([
    ...ENTER,
    'vlan 10',
    'name Sales',
    'vlan 20',
    'interface range f0/1 - 2',
    'switchport access vlan 10',
    'interface g0/1',
    'switchport mode trunk',
    'switchport trunk native vlan 99',
    'switchport trunk allowed vlan 1,10,30-40',
    'interface vlan 1',
    'ip address 192.168.1.2 255.255.255.0',
    'no shutdown',
    'end',
  ]);
  return c;
}

const UP = { 'FastEthernet0/1': true, 'GigabitEthernet0/1': true };

describe('show vlan brief', () => {
  it('lists each VLAN with its access ports, then the media VLANs', () => {
    expect(trunkSwitch().run('show vlan brief')).toEqual([
      '',
      'VLAN Name                             Status    Ports',
      '---- -------------------------------- --------- -------------------------------',
      '1    default                          active    Fa0/3',
      '10   Sales                            active    Fa0/1, Fa0/2',
      '20   VLAN0020                         active',
      '1002 fddi-default                     act/unsup',
      '1003 token-ring-default               act/unsup',
      '1004 fddinet-default                  act/unsup',
      '1005 trnet-default                    act/unsup',
    ]);
  });

  it('wraps a long port list four to a row', () => {
    const lines = switchDevice().ports.length;
    const output = consoleOn(switchDevice()).run('show vlan brief');

    expect(lines).toBe(26);
    expect(output.slice(3, 5)).toEqual([
      '1    default                          active    Fa0/1, Fa0/2, Fa0/3, Fa0/4',
      '                                                Fa0/5, Fa0/6, Fa0/7, Fa0/8',
    ]);
  });
});

describe('show interfaces trunk', () => {
  it('lists the trunks that are up, with allowed and active VLANs', () => {
    const { live, output } = showWith(trunkSwitch(), 'show interfaces trunk', 'ports', UP);

    expect(live).toEqual([
      'Port        Mode         Encapsulation  Status        Native vlan',
      'Gi0/1       on           802.1q         trunking      99',
      '',
      'Port        Vlans allowed on trunk',
      'Gi0/1       1,10,30-40',
      '',
      'Port        Vlans allowed and active in management domain',
      'Gi0/1       1,10',
      '',
      'Port        Vlans in spanning tree forwarding state and not pruned',
      'Gi0/1       1,10',
    ]);
    // Without a simulation, a trunk that is not shut down counts as up.
    expect(output).toEqual(live);
  });

  it('prints nothing while the trunk link is down', () => {
    const { live } = showWith(trunkSwitch(), 'show interfaces trunk', 'ports', {});

    expect(live).toEqual([]);
  });
});

describe('show interfaces switchport', () => {
  it('shows one port, operationally down while its link is', () => {
    const { live } = showWith(trunkSwitch(), 'show interfaces f0/2 switchport', 'ports', UP);

    expect(live).toEqual([
      'Name: Fa0/2',
      'Switchport: Enabled',
      'Administrative Mode: static access',
      'Operational Mode: down',
      'Administrative Trunking Encapsulation: dot1q',
      'Operational Trunking Encapsulation: native',
      'Negotiation of Trunking: Off',
      'Access Mode VLAN: 10 (Sales)',
      'Trunking Native Mode VLAN: 1 (default)',
      'Voice VLAN: none',
      'Trunking VLANs Enabled: ALL',
      'Pruning VLANs Enabled: 2-1001',
      'Protected: false',
      'Appliance trust: none',
    ]);
  });

  it('shows every port, a blank line apart', () => {
    const { live } = showWith(trunkSwitch(), 'show interfaces switchport', 'ports', UP);

    expect(live.filter((row) => row.startsWith('Name: '))).toEqual([
      'Name: Fa0/1',
      'Name: Fa0/2',
      'Name: Fa0/3',
      'Name: Gi0/1',
    ]);
    expect(live).toContain('Trunking VLANs Enabled: 1,10,30-40');
    expect(live).toContain('Trunking Native Mode VLAN: 99 (Inactive)');
  });
});

describe('interface status from link state', () => {
  it('shows ports, subinterfaces and VLAN interfaces as the links are', () => {
    const r = consoleOn(router(['GigabitEthernet0/0', 'GigabitEthernet0/1']));
    r.runAll([
      ...ENTER,
      'interface g0/0',
      'no shutdown',
      'interface g0/0.10',
      'encapsulation dot1Q 10',
      'ip address 192.168.10.1 255.255.255.0',
      'interface g0/1',
      'no shutdown',
      'end',
    ]);

    const up: Record<string, boolean> = { 'GigabitEthernet0/0': true };
    const { live, output } = showWith(r, 'show ip interface brief', 'ports', up);

    expect(live).toEqual([
      'Interface              IP-Address      OK? Method Status                Protocol',
      'GigabitEthernet0/0     unassigned      YES unset  up                    up',
      'GigabitEthernet0/0.10  192.168.10.1    YES manual up                    up',
      'GigabitEthernet0/1     unassigned      YES unset  down                  down',
    ]);
    expect(output.at(-1)).toBe(
      'GigabitEthernet0/1     unassigned      YES unset  up                    up',
    );
  });

  it('brings a VLAN interface up while an up port carries its VLAN', () => {
    const c = trunkSwitch();
    const vlan1 = (ports: Record<string, boolean>) =>
      showWith(c, 'show interfaces vlan 1', 'ports', ports).live[0];

    expect(vlan1(UP)).toBe('Vlan1 is up, line protocol is up');
    expect(vlan1({ 'FastEthernet0/1': true })).toBe('Vlan1 is up, line protocol is down');
    expect(vlan1({})).toBe('Vlan1 is up, line protocol is down');
  });
});
