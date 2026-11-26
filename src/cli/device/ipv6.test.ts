import { describe, expect, it } from 'vitest';
import type { Ipv6Status, TraceEvent } from '../../engine/api';
import type { RouterConfig } from '../../model';
import type { Ipv6Address } from '../../model/ipv6';
import { pingOutput } from './ping';
import type { EngineAnswers } from './query';
import { applyLines, withBlankConfig } from './session';
import { runningConfig } from './show';
import { consoleOn, router, switchDevice } from './testing';
import { tracerouteOutput } from './traceroute';

const ENTER = ['enable', 'configure terminal'];
const NO_ENGINE = ['% The simulation is not running, so there is no live state to show.'];
const G00 = 'GigabitEthernet0/0';

const v6 = (text: string) => text as Ipv6Address;
const cidr = (address: string, prefixLength: number) => ({ address: v6(address), prefixLength });

function configured(lines: readonly string[]) {
  const c = consoleOn(router());
  const output = c.runAll([...ENTER, ...lines]).slice(1);
  return { c, output, config: c.device.config as RouterConfig };
}

const ipv6Of = (config: RouterConfig, port: string) => config.interfaces[port as never]?.ipv6;

/** Runs a show command and answers its query with `status`, as a terminal does. */
function showWith(c: ReturnType<typeof consoleOn>, line: string, status: Ipv6Status) {
  const { output, query } = c.session.run(c.device, line);
  if (query?.kind !== 'ipv6') throw new Error(`${line} asked for ${query?.kind}, not ipv6`);
  const render = query.render as (answer: EngineAnswers['ipv6']) => readonly string[];
  return { live: render(status), output };
}

describe('ipv6 interface config', () => {
  it('keeps addresses canonical, in entry order, without duplicates', () => {
    const { config } = configured([
      'interface g0/0',
      'ipv6 address 2001:DB8:1:0::1/64',
      'ipv6 address 2001:db8:2::5/64 eui-64',
      'ipv6 address 2001:db8:1::1/64',
      'ipv6 address FE80::1 link-local',
    ]);
    expect(ipv6Of(config, G00)).toEqual({
      addresses: [
        { cidr: cidr('2001:db8:1::1', 64), eui64: false },
        { cidr: cidr('2001:db8:2::', 64), eui64: true },
      ],
      linkLocal: 'fe80::1',
    });
  });

  it('turns IPv6 on with enable or autoconfig, and off once nothing keeps it on', () => {
    const { c, config } = configured(['interface g0/0', 'ipv6 enable', 'ipv6 address autoconfig']);
    expect(ipv6Of(config, G00)).toEqual({ addresses: [], enabled: true, autoconfig: true });

    c.runAll(['no ipv6 enable', 'no ipv6 address autoconfig']);
    expect(ipv6Of(c.device.config as RouterConfig, G00)).toBeUndefined();
  });

  it('removes one address, the EUI-64 prefix, the link-local, or all with no ipv6 address', () => {
    const { c } = configured([
      'interface g0/0',
      'ipv6 address 2001:db8:1::1/64',
      'ipv6 address 2001:db8:3::1/64',
      'ipv6 address 2001:db8:2::/64 eui-64',
      'ipv6 address fe80::1 link-local',
      'ipv6 enable',
    ]);
    const current = () => ipv6Of(c.device.config as RouterConfig, G00);

    c.run('no ipv6 address 2001:db8:1::1/64');
    c.run('no ipv6 address 2001:db8:2::/64 eui-64');
    expect(current()?.addresses).toEqual([{ cidr: cidr('2001:db8:3::1', 64), eui64: false }]);

    c.run('no ipv6 address fe80::1 link-local');
    expect(current()).not.toHaveProperty('linkLocal');

    c.runAll(['ipv6 address fe80::1 link-local', 'no ipv6 address']);
    expect(current()).toEqual({ addresses: [], enabled: true });
  });

  it('refuses a link-local address outside FE80::/10', () => {
    const { output, config } = configured([
      'interface g0/0',
      'ipv6 address 2001:db8::1 link-local',
    ]);
    expect(output.at(-1)).toBe('% Invalid link-local address');
    expect(ipv6Of(config, G00)).toBeUndefined();
  });

  it('configures a subinterface and every interface of a range', () => {
    const { config } = configured([
      'interface g0/0.10',
      'encapsulation dot1Q 10',
      'ipv6 address 2001:db8:10::1/64',
      'interface range g0/0 - 1',
      'ipv6 enable',
    ]);
    expect(config.subinterfaces['GigabitEthernet0/0.10' as never]?.ipv6?.addresses).toEqual([
      { cidr: cidr('2001:db8:10::1', 64), eui64: false },
    ]);
    expect(ipv6Of(config, G00)?.enabled).toBe(true);
    expect(ipv6Of(config, 'GigabitEthernet0/1')?.enabled).toBe(true);
  });

  it('is not a switch command', () => {
    const c = consoleOn(switchDevice());
    const output = c.runAll([
      ...ENTER,
      'interface f0/1',
      'ipv6 enable',
      'exit',
      'ipv6 unicast-routing',
    ]);
    expect(output.filter((line) => line.startsWith('%'))).toHaveLength(2);
  });

  it('helps with ipv6 address as IOS does', () => {
    const { c } = configured(['interface g0/0']);
    expect(c.session.help(c.device, 'ipv6 address ')).toEqual([
      '  X:X:X:X::X          IPv6 link-local address',
      '  X:X:X:X::X/<0-128>  IPv6 prefix',
      '  autoconfig          Obtain address using autoconfiguration',
    ]);
    expect(c.session.help(c.device, 'ipv6 address 2001:db8::1/64 ')).toEqual([
      '  eui-64  Use eui-64 interface identifier',
      '  <cr>',
    ]);
    expect(c.session.help(c.device, 'ipv6 ')).toEqual([
      '  address  Configure IPv6 address on interface',
      '  enable   Enable IPv6 on interface',
    ]);
  });
});

describe('ipv6 global config', () => {
  it('turns unicast routing on and off', () => {
    const { c, config } = configured(['ipv6 unicast-routing']);
    expect(config.ipv6UnicastRouting).toBe(true);
    c.run('no ipv6 unicast-routing');
    expect(c.device.config).not.toHaveProperty('ipv6UnicastRouting');
  });

  it('keeps static routes in each form, the prefix masked and distance 1 left out', () => {
    const { config } = configured([
      'ipv6 route ::/0 2001:DB8:2::194',
      'ipv6 route 2001:db8:3::1/64 s0/0/0',
      'ipv6 route 2001:db8:4::/64 g0/0 fe80::2 1',
      'ipv6 route 2001:db8:5::/64 2001:db8:2::1 200',
      'ipv6 route 2001:db8:6::/64 s0/0/1 10',
      'ipv6 route 2001:db8:5::/64 2001:db8:2::1 150',
    ]);
    expect(config.ipv6StaticRoutes).toEqual([
      { prefix: cidr('::', 0), nextHop: { kind: 'address', address: '2001:db8:2::194' } },
      {
        prefix: cidr('2001:db8:3::', 64),
        nextHop: { kind: 'interface', interface: 'Serial0/0/0' },
      },
      {
        prefix: cidr('2001:db8:4::', 64),
        nextHop: { kind: 'address', address: 'fe80::2', interface: G00 },
      },
      {
        prefix: cidr('2001:db8:5::', 64),
        nextHop: { kind: 'address', address: '2001:db8:2::1' },
        distance: 150,
      },
      {
        prefix: cidr('2001:db8:6::', 64),
        nextHop: { kind: 'interface', interface: 'Serial0/0/1' },
        distance: 10,
      },
    ]);
  });

  it('refuses a link-local next hop without its interface', () => {
    const { output, config } = configured(['ipv6 route 2001:db8:4::/64 fe80::2']);
    expect(output).toEqual(['% Interface has to be specified for a link-local nexthop']);
    expect(config).not.toHaveProperty('ipv6StaticRoutes');
  });

  it('removes routes by prefix, narrowed by next hop or interface', () => {
    const { c } = configured([
      'ipv6 route ::/0 2001:db8:2::1',
      'ipv6 route ::/0 2001:db8:2::2',
      'ipv6 route 2001:db8:3::/64 s0/0/0',
      'ipv6 route 2001:db8:3::/64 s0/0/1',
      'ipv6 route 2001:db8:4::/64 g0/0 fe80::2',
    ]);
    const routes = () => (c.device.config as RouterConfig).ipv6StaticRoutes ?? [];

    c.run('no ipv6 route ::/0 2001:db8:2::1');
    c.run('no ipv6 route 2001:db8:3::/64 s0/0/1');
    expect(routes().map((r) => r.nextHop)).toEqual([
      { kind: 'address', address: '2001:db8:2::2' },
      { kind: 'interface', interface: 'Serial0/0/0' },
      { kind: 'address', address: 'fe80::2', interface: G00 },
    ]);

    c.runAll([
      'no ipv6 route ::/0',
      'no ipv6 route 2001:db8:3::/64',
      'no ipv6 route 2001:db8:4::/64 g0/0 fe80::2',
    ]);
    expect(c.device.config).not.toHaveProperty('ipv6StaticRoutes');
  });

  it('helps with ipv6 route as IOS does', () => {
    const { c } = configured([]);
    expect(c.session.help(c.device, 'ipv6 route ')).toEqual(['  X:X:X:X::X/<0-128>  IPv6 prefix']);
    expect(c.session.help(c.device, 'ipv6 route ::/0 ')).toEqual([
      '  FastEthernet     FastEthernet IEEE 802.3',
      '  GigabitEthernet  GigabitEthernet IEEE 802.3z',
      '  Loopback         Loopback interface',
      '  Port-channel     Ethernet Channel of interfaces',
      '  Serial           Serial',
      '  Vlan             Catalyst Vlans',
      '  X:X:X:X::X       IPv6 address of next-hop',
    ]);
    expect(c.session.help(c.device, 'ipv6 route ::/0 2001:db8::1 ')).toEqual([
      '  <1-254>  Administrative distance',
      '  <cr>',
    ]);
    expect(c.session.help(c.device, 'ipv6 route ::/0 g0/0 ')).toEqual([
      '  <1-254>     Administrative distance',
      '  X:X:X:X::X  IPv6 address of next-hop',
      '  <cr>',
    ]);
  });
});

const LAB = [
  'ipv6 unicast-routing',
  'interface g0/0',
  'ip address 192.168.1.1 255.255.255.0',
  'duplex full',
  'ipv6 address 2001:db8:2::/64 eui-64',
  'ipv6 address 2001:db8:1::1/64',
  'ipv6 address fe80::1 link-local',
  'ipv6 address autoconfig',
  'ipv6 enable',
  'no shutdown',
  'interface s0/0/0',
  'ipv6 address 2001:db8:da:2::1/64',
  'clock rate 128000',
  'exit',
  'ip route 0.0.0.0 0.0.0.0 192.168.1.254',
  'ipv6 route ::/0 s0/0/0',
  'ipv6 route 2001:db8:4::/64 g0/0 fe80::2 5',
];

describe('ipv6 in running-config', () => {
  it('prints IOS lines in IOS places, in upper case', () => {
    const { config, c } = configured(LAB);
    const lines = runningConfig({ ...c.device, config });
    const at = (line: string) => lines.indexOf(line);
    expect(lines.slice(at('hostname Router'), at('interface GigabitEthernet0/0'))).toEqual([
      'hostname Router',
      '!',
      'ipv6 unicast-routing',
      '!',
    ]);
    expect(
      lines.slice(at('interface GigabitEthernet0/0'), at('interface GigabitEthernet0/1')),
    ).toEqual([
      'interface GigabitEthernet0/0',
      ' ip address 192.168.1.1 255.255.255.0',
      ' duplex full',
      ' ipv6 address FE80::1 link-local',
      ' ipv6 address 2001:DB8:2::/64 eui-64',
      ' ipv6 address 2001:DB8:1::1/64',
      ' ipv6 address autoconfig',
      ' ipv6 enable',
      '!',
    ]);
    expect(lines.slice(at('interface Serial0/0/0'), at('interface Serial0/0/1'))).toEqual([
      'interface Serial0/0/0',
      ' no ip address',
      ' ipv6 address 2001:DB8:DA:2::1/64',
      ' clock rate 128000',
      ' shutdown',
      '!',
    ]);
    expect(lines.slice(at('ip route 0.0.0.0 0.0.0.0 192.168.1.254'), at('line con 0'))).toEqual([
      'ip route 0.0.0.0 0.0.0.0 192.168.1.254',
      '!',
      'ipv6 route ::/0 Serial0/0/0',
      'ipv6 route 2001:DB8:4::/64 GigabitEthernet0/0 FE80::2 5',
      '!',
    ]);
  });

  it('rebuilds the same config when replayed', () => {
    const { c } = configured(LAB);
    const { config, errors } = applyLines(withBlankConfig(c.device), runningConfig(c.device));
    expect(errors).toEqual([]);
    expect(config).toEqual(c.device.config);
  });

  it('loads the IPv6 lines of a Packet Tracer running-config', () => {
    const pt = [
      'hostname R1',
      '!',
      'no ip cef',
      'ipv6 unicast-routing',
      '!',
      'no ipv6 cef',
      '!',
      'interface GigabitEthernet0/0',
      ' no ip address',
      ' duplex auto',
      ' speed auto',
      ' ipv6 address FE80::1 link-local',
      ' ipv6 address 2001:DB8:DA:1::1/64',
      '!',
      'ip classless',
      '!',
      'ipv6 route ::/0 Serial0/0/1',
      '!',
    ];
    const { config, errors } = applyLines(withBlankConfig(router()), pt);
    expect(errors).toEqual([]);
    expect(config.ipv6UnicastRouting).toBe(true);
    expect(config.interfaces[G00 as never]?.ipv6).toEqual({
      addresses: [{ cidr: cidr('2001:db8:da:1::1', 64), eui64: false }],
      linkLocal: 'fe80::1',
    });
    expect(config.ipv6StaticRoutes).toEqual([
      { prefix: cidr('::', 0), nextHop: { kind: 'interface', interface: 'Serial0/0/1' } },
    ]);
  });
});

/** A router as the simulation reports it: G0/0 up with two addresses, S0/0/0 up with one. */
const STATUS: Ipv6Status = {
  routing: true,
  interfaces: [
    {
      name: G00 as never,
      up: true,
      linkLocal: v6('fe80::2d0:97ff:fe49:c501'),
      addresses: [
        { ...cidr('2001:1234:a:b::1', 64), origin: 'manual' },
        { ...cidr('2001:db8:2:0:2d0:97ff:fe49:c501', 64), origin: 'eui64' },
      ],
      groups: [
        v6('ff02::1:ff49:c501'),
        v6('ff02::1'),
        v6('ff02::2'),
        v6('ff02::1:ff00:1'),
        v6('ff02::1:ff49:c501'),
      ],
    },
    {
      name: 'Serial0/0/0' as never,
      up: true,
      linkLocal: v6('fe80::2d0:97ff:fe49:c501'),
      addresses: [{ ...cidr('2001:db8:c0de:11::1', 64), origin: 'manual' }],
      groups: [v6('ff02::1'), v6('ff02::2'), v6('ff02::1:ff00:1'), v6('ff02::1:ff49:c501')],
    },
  ],
  routes: [
    {
      source: 'static',
      prefix: cidr('::', 0),
      distance: 1,
      nextHop: { kind: 'address', address: v6('2001:db8:c0de:11::2') },
    },
    { source: 'connected', prefix: cidr('2001:1234:a:b::', 64), interface: G00 as never },
    { source: 'local', prefix: cidr('2001:1234:a:b::1', 128), interface: G00 as never },
    {
      source: 'connected',
      prefix: cidr('2001:db8:c0de:11::', 64),
      interface: 'Serial0/0/0' as never,
    },
    {
      source: 'local',
      prefix: cidr('2001:db8:c0de:11::1', 128),
      interface: 'Serial0/0/0' as never,
    },
    {
      source: 'static',
      prefix: cidr('2001:db8:3::', 64),
      distance: 5,
      nextHop: { kind: 'interface', interface: 'Serial0/0/0' as never },
    },
    {
      source: 'static',
      prefix: cidr('2001:db8:4::', 64),
      distance: 1,
      nextHop: { kind: 'address', address: v6('fe80::2'), interface: G00 as never },
    },
    {
      source: 'static',
      prefix: cidr('2001:db8:4::', 64),
      distance: 1,
      nextHop: { kind: 'address', address: v6('fe80::3'), interface: G00 as never },
    },
  ],
  neighbors: [
    {
      address: v6('2001:1234:a:b::a'),
      mac: '00:01:42:7e:e8:ed' as never,
      interface: G00 as never,
      ageMs: 11 * 60_000 + 59_000,
      state: 'REACH',
      router: false,
    },
    {
      address: v6('fe80::201:42ff:fe7e:e8ed'),
      mac: '00:01:42:7e:e8:ed' as never,
      interface: 'Serial0/0/0' as never,
      ageMs: 5_000,
      state: 'STALE',
      router: true,
    },
  ],
  ports: Object.fromEntries([
    [G00, true],
    ['GigabitEthernet0/1', false],
    ['Serial0/0/0', true],
    ['Serial0/0/1', false],
  ]),
};

const DETAIL_TAIL = [
  '  MTU is 1500 bytes',
  '  ICMP error messages limited to one every 100 milliseconds',
  '  ICMP redirects are enabled',
  '  ICMP unreachables are sent',
  '  ND DAD is enabled, number of DAD attempts: 1',
  '  ND reachable time is 30000 milliseconds (using 30000)',
];

const G00_DETAIL = [
  'GigabitEthernet0/0 is up, line protocol is up',
  '  IPv6 is enabled, link-local address is FE80::2D0:97FF:FE49:C501',
  '  No Virtual link-local address(es):',
  '  Global unicast address(es):',
  '    2001:1234:A:B::1, subnet is 2001:1234:A:B::/64',
  '    2001:DB8:2:0:2D0:97FF:FE49:C501, subnet is 2001:DB8:2::/64 [EUI]',
  '  Joined group address(es):',
  '    FF02::1',
  '    FF02::2',
  '    FF02::1:FF00:1',
  '    FF02::1:FF49:C501',
  ...DETAIL_TAIL,
  '  ND advertised reachable time is 0 (unspecified)',
  '  ND advertised retransmit interval is 0 (unspecified)',
  '  ND router advertisements are sent every 200 seconds',
  '  ND router advertisements live for 1800 seconds',
  '  ND advertised default router preference is Medium',
  '  Hosts use stateless autoconfig for addresses.',
];

describe('show ipv6 interface', () => {
  it('lists every interface briefly from the simulation, link-local first', () => {
    const { c } = configured(['interface g0/0', 'no shutdown']);
    const { live } = showWith(c, 'do show ipv6 interface brief', STATUS);
    expect(live).toEqual([
      'GigabitEthernet0/0         [up/up]',
      '    FE80::2D0:97FF:FE49:C501',
      '    2001:1234:A:B::1',
      '    2001:DB8:2:0:2D0:97FF:FE49:C501',
      'GigabitEthernet0/1         [administratively down/down]',
      '    unassigned',
      'Serial0/0/0                [administratively down/down]',
      '    FE80::2D0:97FF:FE49:C501',
      '    2001:DB8:C0DE:11::1',
      'Serial0/0/1                [administratively down/down]',
      '    unassigned',
    ]);
  });

  it('details the named interface, its groups sorted and RAs as a router sends them', () => {
    const { c } = configured(['interface range g0/0 - 1', 'no shutdown']);
    expect(showWith(c, 'do show ipv6 interface g0/0', STATUS).live).toEqual(G00_DETAIL);
    expect(showWith(c, 'do show ipv6 interface s0/0/0', STATUS).live.slice(-4)).toEqual([
      '  ND advertised reachable time is 0 (unspecified)',
      '  ND advertised retransmit interval is 0 (unspecified)',
      '  ND RAs are suppressed (periodic)',
      '  Hosts use stateless autoconfig for addresses.',
    ]);
    expect(showWith(c, 'do show ipv6 interface g0/1', STATUS).live).toEqual([
      'GigabitEthernet0/1 is down, line protocol is down',
    ]);
  });

  it('details only the interfaces with IPv6 when no name is given', () => {
    const { c } = configured(['interface g0/0', 'no shutdown']);
    const { live } = showWith(c, 'do show ipv6 interface', STATUS);
    expect(live.filter((line) => !line.startsWith(' '))).toEqual([
      'GigabitEthernet0/0 is up, line protocol is up',
      'Serial0/0/0 is administratively down, line protocol is down',
    ]);
  });

  it('marks SLAAC addresses, and addresses on a down interface as tentative', () => {
    const { c } = configured(['interface g0/0', 'no shutdown']);
    const [g00] = STATUS.interfaces;
    const status: Ipv6Status = {
      ...STATUS,
      routing: false,
      interfaces: [
        {
          ...g00!,
          up: false,
          addresses: [{ ...cidr('2001:db8:9:0:2d0:97ff:fe49:c501', 64), origin: 'autoconfig' }],
        },
      ],
    };
    expect(showWith(c, 'do show ipv6 interface g0/0', status).live).toEqual([
      'GigabitEthernet0/0 is up, line protocol is up',
      '  IPv6 is tentative, link-local address is FE80::2D0:97FF:FE49:C501 [TEN]',
      '  No Virtual link-local address(es):',
      '  Global unicast address(es):',
      '    2001:DB8:9:0:2D0:97FF:FE49:C501, subnet is 2001:DB8:9::/64 [EUI/CAL/PRE/TEN]',
      '  Joined group address(es):',
      '    FF02::1',
      '    FF02::2',
      '    FF02::1:FF00:1',
      '    FF02::1:FF49:C501',
      ...DETAIL_TAIL,
    ]);
  });

  it('derives addresses and groups from the config without the simulation', () => {
    const { c } = configured([
      'interface g0/0',
      'ipv6 address 2001:db8:1::1/64',
      'ipv6 address 2001:db8:2::/64 eui-64',
      'no shutdown',
      'interface s0/0/0',
      'ipv6 enable',
    ]);
    // Serial0/0/0 has no MAC of its own, so it takes G0/0's for its EUI-64 identifier.
    expect(c.device.ports[0]).toMatchObject({ mac: '5a:63:12:7c:65:cd' });
    const host = '5863:12FF:FE7C:65CD';
    const linkLocal = `FE80::${host}`;
    const solicited = 'FF02::1:FF7C:65CD';

    expect(c.run('do show ipv6 interface brief')).toEqual([
      'GigabitEthernet0/0         [up/up]',
      `    ${linkLocal}`,
      '    2001:DB8:1::1',
      `    2001:DB8:2:0:${host}`,
      'GigabitEthernet0/1         [administratively down/down]',
      '    unassigned',
      'Serial0/0/0                [administratively down/down]',
      `    ${linkLocal}`,
      'Serial0/0/1                [administratively down/down]',
      '    unassigned',
    ]);
    expect(c.run('do show ipv6 interface g0/0')).toEqual([
      'GigabitEthernet0/0 is up, line protocol is up',
      `  IPv6 is enabled, link-local address is ${linkLocal}`,
      '  No Virtual link-local address(es):',
      '  Global unicast address(es):',
      '    2001:DB8:1::1, subnet is 2001:DB8:1::/64',
      `    2001:DB8:2:0:${host}, subnet is 2001:DB8:2::/64 [EUI]`,
      '  Joined group address(es):',
      '    FF02::1',
      '    FF02::1:FF00:1',
      `    ${solicited}`,
      ...DETAIL_TAIL,
    ]);
    expect(c.run('do show ipv6 interface s0/0/0').slice(1, 4)).toEqual([
      `  IPv6 is tentative, link-local address is ${linkLocal} [TEN]`,
      '  No Virtual link-local address(es):',
      '  No global unicast address is configured',
    ]);
  });

  it('refuses an interface the router does not have', () => {
    const { c } = configured([]);
    expect(c.run('do show ipv6 interface g0/9')).toEqual([
      "% Invalid input detected at '^' marker.",
    ]);
  });
});

describe('show ipv6 route', () => {
  it('counts and prints the table in IOS 15 format, the multicast route last', () => {
    const { c } = configured([]);
    const { live, output } = showWith(c, 'do show ipv6 route', STATUS);
    expect(output).toEqual(NO_ENGINE);
    expect(live).toEqual([
      'IPv6 Routing Table - 8 entries',
      'Codes: C - Connected, L - Local, S - Static, R - RIP, B - BGP',
      '       U - Per-user Static route, M - MIPv6',
      '       I1 - ISIS L1, I2 - ISIS L2, IA - ISIS interarea, IS - ISIS summary',
      '       ND - ND Default, NDp - ND Prefix, DCE - Destination, NDr - Redirect',
      '       O - OSPF intra, OI - OSPF inter, OE1 - OSPF ext 1, OE2 - OSPF ext 2',
      '       ON1 - OSPF NSSA ext 1, ON2 - OSPF NSSA ext 2',
      '       D - EIGRP, EX - EIGRP external',
      'S   ::/0 [1/0]',
      '     via 2001:DB8:C0DE:11::2',
      'C   2001:1234:A:B::/64 [0/0]',
      '     via GigabitEthernet0/0, directly connected',
      'L   2001:1234:A:B::1/128 [0/0]',
      '     via GigabitEthernet0/0, receive',
      'C   2001:DB8:C0DE:11::/64 [0/0]',
      '     via Serial0/0/0, directly connected',
      'L   2001:DB8:C0DE:11::1/128 [0/0]',
      '     via Serial0/0/0, receive',
      'S   2001:DB8:3::/64 [5/0]',
      '     via Serial0/0/0, directly connected',
      'S   2001:DB8:4::/64 [1/0]',
      '     via FE80::2, GigabitEthernet0/0',
      '     via FE80::3, GigabitEthernet0/0',
      'L   FF00::/8 [0/0]',
      '     via Null0, receive',
    ]);
  });
});

describe('show ipv6 neighbors', () => {
  it('prints the cache with minutes, dotted upper-case MACs and short interface names', () => {
    const { c } = configured([]);
    const { live, output } = showWith(c, 'do show ipv6 neighbors', STATUS);
    expect(output).toEqual(NO_ENGINE);
    expect(live).toEqual([
      'IPv6 Address                              Age Link-layer Addr State Interface',
      '2001:1234:A:B::A                           11 0001.427E.E8ED  REACH Gig0/0',
      'FE80::201:42FF:FE7E:E8ED                    0 0001.427E.E8ED  STALE Se0/0/0',
    ]);
  });
});

describe('IPv6 ping and traceroute', () => {
  const ping = (target: string, count = 5, timeoutMs = 2000) => ({
    kind: 'ping',
    target,
    options: { count, timeoutMs },
  });

  it('streams ping ipv6 and ping of an IPv6 address, with the IPv4 options', () => {
    const c = consoleOn(router());
    c.run('enable');
    const run = (line: string) => c.session.run(c.device, line).stream;
    expect(run('ping ipv6 2001:DB8:ACAD:1::1')).toEqual(ping('2001:db8:acad:1::1'));
    expect(run('ping 2001:db8:acad:1:0::1 repeat 2')).toEqual(ping('2001:db8:acad:1::1', 2));
    expect(run('ping ipv6 2001:db8::1 timeout 1 repeat 3')).toEqual(ping('2001:db8::1', 3, 1000));
    expect(run('ping 10.0.0.1')).toEqual(ping('10.0.0.1'));
  });

  it('streams traceroute ipv6 and traceroute of an IPv6 address', () => {
    const c = consoleOn(router());
    const run = (line: string) => c.session.run(c.device, line).stream;
    const trace = {
      kind: 'traceroute',
      target: '2001:db8:acad:171::1',
      options: expect.anything(),
    };
    expect(run('traceroute ipv6 2001:DB8:ACAD:171::1')).toEqual(trace);
    expect(run('traceroute 2001:db8:acad:171::1')).toEqual(trace);
  });

  it('pings and traces IPv6 only on a router', () => {
    const c = consoleOn(switchDevice());
    expect(c.session.run(c.device, 'ping 2001:db8::1').stream).toBeUndefined();
    expect(c.session.run(c.device, 'traceroute ipv6 2001:db8::1').stream).toBeUndefined();
  });

  it('echoes the target in lower case and prints hop addresses in upper case', () => {
    const target = v6('2001:db8:acad:200::226');
    expect(pingOutput({ kind: 'ping', target, options: { count: 5, timeoutMs: 2000 } }).head).toBe(
      'Type escape sequence to abort.\n' +
        'Sending 5, 100-byte ICMP Echos to 2001:db8:acad:200::226, timeout is 2 seconds:\n',
    );
    const trace = tracerouteOutput({
      kind: 'traceroute',
      target,
      options: { maxHops: 30, probesPerHop: 3, timeoutMs: 3000 },
    });
    expect(trace.head).toBe(
      'Type escape sequence to abort.\nTracing the route to 2001:db8:acad:200::226\n\n',
    );
    const hop: TraceEvent = {
      kind: 'ttl-expired',
      hop: 1,
      probe: 1,
      from: v6('2001:db8:acad::1'),
      timeMs: 0,
    };
    expect(trace.next(hop)).toBe('  1 2001:DB8:ACAD::1 0 msec');
  });
});
