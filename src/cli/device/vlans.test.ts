import { describe, expect, it } from 'vitest';
import type { RouterConfig, SwitchConfig } from '../../model';
import { INVALID_INPUT, type IosDevice } from './context';
import { applyLines, withBlankConfig } from './session';
import { runningConfig } from './show';
import { consoleOn, router, switchDevice } from './testing';

const ENTER = ['enable', 'configure terminal'];

function after<C>(device: IosDevice, lines: readonly string[], read: (config: C) => unknown) {
  const c = consoleOn(device);
  const output = c.runAll([...ENTER, ...lines]);
  return { value: read(c.device.config as C), output: output.slice(1), console: c };
}

const r = (lines: string[], read: (config: RouterConfig) => unknown) =>
  after(router(), lines, read).value;
const s = (lines: string[], read: (config: SwitchConfig) => unknown) =>
  after(switchDevice(), lines, read).value;

const sub10 = (c: RouterConfig) => c.subinterfaces['GigabitEthernet0/0.10' as never];
const g01 = (c: SwitchConfig) => c.interfaces['GigabitEthernet0/1' as never]?.switchport;
const range = (first: number, last = first) => ({ first, last });

describe('router subinterfaces', () => {
  it.each<[string, string[], (c: RouterConfig) => unknown, unknown]>([
    ['interface creates it', ['interface g0/0.10'], sub10, { shutdown: false }],
    [
      'encapsulation dot1Q',
      ['int g0/0.10', 'encapsulation dot1Q 10'],
      sub10,
      { shutdown: false, encapsulation: { vlan: 10, native: false } },
    ],
    [
      'encapsulation dot1Q native',
      ['int g0/0.10', 'encapsulation dot1q 10 native'],
      (c) => sub10(c)?.encapsulation,
      { vlan: 10, native: true },
    ],
    [
      'ip address after the encapsulation',
      ['int g0/0.10', 'encap dot1q 10', 'ip address 192.168.10.1 255.255.255.0'],
      (c) => sub10(c)?.ipv4,
      { address: '192.168.10.1', prefixLength: 24 },
    ],
    [
      'no encapsulation also drops the address',
      [
        'int g0/0.10',
        'encap dot1q 10',
        'ip add 192.168.10.1 255.255.255.0',
        'no encapsulation dot1Q',
      ],
      sub10,
      { shutdown: false },
    ],
    ['shutdown', ['int g0/0.10', 'shutdown'], (c) => sub10(c)?.shutdown, true],
    ['no shutdown', ['int g0/0.10', 'shut', 'no shut'], (c) => sub10(c)?.shutdown, false],
    ['description', ['int g0/0.10', 'description Sales'], (c) => sub10(c)?.description, 'Sales'],
    ['no interface deletes it', ['int g0/0.10', 'exit', 'no int g0/0.10'], sub10, undefined],
  ])('%s', (_name, lines, read, expected) => {
    expect(r(lines, read)).toEqual(expected);
  });

  it('enters config-subif, and exit returns to global config', () => {
    const c = consoleOn(router());
    c.runAll([...ENTER, 'interface GigabitEthernet0/0.20']);
    expect(c.prompt).toBe('Router(config-subif)#');
    c.run('exit');
    expect(c.prompt).toBe('Router(config)#');
  });

  it.each<[string, 'router' | 'switch', string[], readonly string[]]>([
    [
      'an address before the encapsulation',
      'router',
      ['int g0/0.10', 'ip address 192.168.10.1 255.255.255.0'],
      [
        '% Configuring IP routing on a LAN subinterface is only allowed if that subinterface is already configured as part of an IEEE 802.10, IEEE 802.1Q, or ISL vLAN.',
      ],
    ],
    [
      'a VLAN another subinterface of the port tags',
      'router',
      ['int g0/0.10', 'encap dot1q 10', 'int g0/0.11', 'encap dot1q 10'],
      [
        'Configuration of multiple subinterfaces of the same main interface with the same VID (10) is not permitted. This VID is already configured on GigabitEthernet0/0.10.',
      ],
    ],
    [
      'a second native VLAN on one port',
      'router',
      ['int g0/0.10', 'encap dot1q 10 native', 'int g0/0.20', 'encap dot1q 20 native'],
      ['% Native VLAN is already configured on GigabitEthernet0/0.10'],
    ],
    [
      'an address that overlaps another subinterface',
      'router',
      [
        'int g0/0.10',
        'encap dot1q 10',
        'ip add 192.168.10.1 255.255.255.0',
        'int g0/0.20',
        'encap dot1q 20',
        'ip add 192.168.10.2 255.255.255.0',
      ],
      ['% 192.168.10.0 overlaps with GigabitEthernet0/0.10'],
    ],
    ['a subinterface on a serial port', 'router', ['interface s0/0/0.1'], [INVALID_INPUT]],
    ['a subinterface of a missing port', 'router', ['interface g0/9.1'], [INVALID_INPUT]],
    ['a subinterface on a switch', 'switch', ['interface g0/1.10'], [INVALID_INPUT]],
    ['speed on a subinterface', 'router', ['int g0/0.10', 'speed 100'], [INVALID_INPUT]],
  ])('refuses %s', (_name, kind, lines, expected) => {
    const c = consoleOn(kind === 'router' ? router() : switchDevice());
    c.runAll([...ENTER, ...lines.slice(0, -1)]);
    const before = c.device;

    // A line the parser refuses has a caret line above the message.
    expect(c.run(lines.at(-1)!).slice(-1)).toEqual(expected);
    expect(c.device).toBe(before);
  });
});

describe('switchport trunk allowed vlan', () => {
  const trunk = ['int g0/1', 'switchport mode trunk'];

  it.each<[string, string[], unknown]>([
    ['a list', ['sw trunk allowed vlan 10,20,30-40'], [range(10), range(20), range(30, 40)]],
    ['add', ['sw trunk allowed vlan 10', 'sw trunk allowed vlan add 11-12'], [range(10, 12)]],
    ['remove from all', ['sw trunk allowed vlan remove 20'], [range(1, 19), range(21, 4094)]],
    ['remove from a list', ['sw tr al vl 10,20', 'sw tr al vl remove 10'], [range(20)]],
    ['except', ['sw trunk allowed vlan except 1-9'], [range(10, 4094)]],
    ['none', ['sw trunk allowed vlan none'], []],
    ['all', ['sw trunk allowed vlan 10', 'sw trunk allowed vlan all'], undefined],
    ['no', ['sw trunk allowed vlan 10', 'no sw trunk allowed vlan'], undefined],
    ['adding back every VLAN', ['sw tr al vl remove 5', 'sw tr al vl add 5'], undefined],
  ])('%s', (_name, lines, expected) => {
    expect(s([...trunk, ...lines], (c) => g01(c)?.allowedVlans)).toEqual(expected);
  });

  it('keeps the list when the port goes back to access mode and returns', () => {
    const lines = [...trunk, 'sw trunk allowed vlan 10', 'sw mode access'];
    expect(s(lines, g01)).toEqual({ mode: 'access', vlan: 1, allowedVlans: [range(10)] });
    expect(s([...lines, 'sw mode trunk'], g01)).toEqual({
      mode: 'trunk',
      nativeVlan: 1,
      allowedVlans: [range(10)],
    });
  });

  it.each(['sw trunk allowed vlan 0', 'sw trunk allowed vlan 4095', 'sw trunk allowed vlan 20-10'])(
    'refuses %j',
    (line) => {
      const { output } = after(switchDevice(), [...trunk, line], () => undefined);
      expect(output.at(-1)).toBe(INVALID_INPUT);
    },
  );
});

describe('running-config with VLANs and subinterfaces', () => {
  const ROUTER_LINES = [
    ...ENTER,
    'hostname R1',
    'interface g0/0',
    'no shutdown',
    'interface g0/0.10',
    'description Sales',
    'encapsulation dot1Q 10',
    'ip address 192.168.10.1 255.255.255.0',
    'interface g0/0.20',
    'encapsulation dot1Q 20',
    'ip address 192.168.20.1 255.255.255.0',
    'interface g0/0.99',
    'encapsulation dot1Q 99 native',
    'shutdown',
    'end',
  ];

  it('lists subinterfaces after their port, encapsulation before address', () => {
    const c = consoleOn(router());
    c.runAll(ROUTER_LINES);
    const config = runningConfig(c.device);
    const start = config.indexOf('interface GigabitEthernet0/0');

    expect(config.slice(start, config.indexOf('interface GigabitEthernet0/1'))).toEqual([
      'interface GigabitEthernet0/0',
      ' no ip address',
      '!',
      'interface GigabitEthernet0/0.10',
      ' description Sales',
      ' encapsulation dot1Q 10',
      ' ip address 192.168.10.1 255.255.255.0',
      '!',
      'interface GigabitEthernet0/0.20',
      ' encapsulation dot1Q 20',
      ' ip address 192.168.20.1 255.255.255.0',
      '!',
      'interface GigabitEthernet0/0.99',
      ' encapsulation dot1Q 99 native',
      ' no ip address',
      ' shutdown',
      '!',
    ]);
  });

  it('prints trunk settings in IOS order', () => {
    const c = consoleOn(switchDevice());
    c.runAll([
      ...ENTER,
      'interface g0/1',
      'switchport trunk native vlan 99',
      'switchport trunk allowed vlan 10,20,99',
      'switchport mode trunk',
      'interface g0/2',
      'switchport mode trunk',
      'switchport trunk allowed vlan none',
      'end',
    ]);
    const config = runningConfig(c.device);
    const start = config.indexOf('interface GigabitEthernet0/1');

    expect(config.slice(start, start + 10)).toEqual([
      'interface GigabitEthernet0/1',
      ' switchport trunk native vlan 99',
      ' switchport trunk allowed vlan 10,20,99',
      ' switchport mode trunk',
      '!',
      'interface GigabitEthernet0/2',
      ' switchport trunk allowed vlan none',
      ' switchport mode trunk',
      '!',
      'interface Vlan1',
    ]);
  });

  it.each([
    ['router', () => router(), ROUTER_LINES],
    [
      'switch',
      () => switchDevice(),
      [
        ...ENTER,
        'vlan 10',
        'name Sales',
        'interface f0/1',
        'switchport access vlan 10',
        'interface g0/1',
        'switchport trunk native vlan 99',
        'switchport trunk allowed vlan remove 2-9',
        'switchport mode trunk',
        'end',
      ],
    ],
  ] as const)('replays a %s running-config to the same config', (_kind, make, lines) => {
    const c = consoleOn(make());
    c.runAll(lines);
    const { config, errors } = applyLines(withBlankConfig(c.device), runningConfig(c.device));

    expect(errors).toEqual([]);
    expect(config).toEqual(c.device.config);
  });
});
