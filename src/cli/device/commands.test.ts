import { describe, expect, it } from 'vitest';
import type { RouterConfig, SwitchConfig } from '../../model';
import { verifySecret } from '../passwords';
import type { IosDevice } from './context';
import { INVALID_INPUT } from './context';
import { runningConfig } from './show';
import { consoleOn, router, switchDevice } from './testing';

const ENTER = ['enable', 'configure terminal'];

/** Runs `lines` from global config on a fresh device and reads one value out of its config. */
function after<C>(device: IosDevice, lines: readonly string[], read: (config: C) => unknown) {
  const c = consoleOn(device);
  const output = c.runAll([...ENTER, ...lines]);
  return { value: read(c.device.config as C), output: output.slice(1), console: c };
}

const r = (lines: string[], read: (config: RouterConfig) => unknown) =>
  after(router(), lines, read).value;
const s = (lines: string[], read: (config: SwitchConfig) => unknown) =>
  after(switchDevice(), lines, read).value;

const g00 = (c: RouterConfig) => c.interfaces['GigabitEthernet0/0' as never];
const s000 = (c: RouterConfig) => c.interfaces['Serial0/0/0' as never];
const f01 = (c: SwitchConfig) => c.interfaces['FastEthernet0/1' as never];
const g01 = (c: SwitchConfig) => c.interfaces['GigabitEthernet0/1' as never];
const route0 = { prefix: { address: '0.0.0.0', prefixLength: 0 } };

describe('global config commands', () => {
  it.each<[string, string[], (c: RouterConfig) => unknown, unknown]>([
    ['hostname', ['hostname Core-1'], (c) => c.hostname, 'Core-1'],
    ['no hostname', ['hostname Core-1', 'no hostname'], (c) => c.hostname, 'Router'],
    ['enable secret', ['enable secret class'], (c) => verifySecret('class', c.enableSecret!), true],
    [
      'enable secret 0',
      ['enable secret 0 class'],
      (c) => verifySecret('class', c.enableSecret!),
      true,
    ],
    [
      'enable secret 5',
      ['enable secret 5 $1$mERr$hx5rVt7rPNoS4wqbXKX7m0'],
      (c) => c.enableSecret,
      '$1$mERr$hx5rVt7rPNoS4wqbXKX7m0',
    ],
    [
      'no enable secret',
      ['enable secret class', 'no enable secret'],
      (c) => c.enableSecret,
      undefined,
    ],
    ['enable password', ['enable password cisco'], (c) => c.enablePassword, 'cisco'],
    ['enable password 7', ['enable password 7 0822455D0A16'], (c) => c.enablePassword, 'cisco'],
    [
      'no enable password',
      ['enable pass cisco', 'no enable pass'],
      (c) => c.enablePassword,
      undefined,
    ],
    [
      'service password-encryption',
      ['service password-encryption'],
      (c) => c.servicePasswordEncryption,
      true,
    ],
    [
      'no service password-encryption',
      ['service password-encryption', 'no service password-encryption'],
      (c) => c.servicePasswordEncryption,
      false,
    ],
    ['banner motd on one line', ['banner motd #Keep out#'], (c) => c.bannerMotd, 'Keep out'],
    [
      'banner motd with ^C delimiters',
      ['banner motd ^CKeep out^C'],
      (c) => c.bannerMotd,
      'Keep out',
    ],
    [
      'banner motd over several lines',
      ['banner motd $', 'Line one', 'Line two $ ignored'],
      (c) => c.bannerMotd,
      '\nLine one\nLine two ',
    ],
    ['no banner motd', ['banner motd #x#', 'no banner motd'], (c) => c.bannerMotd, undefined],
    ['no ip domain-lookup', ['no ip domain-lookup'], (c) => c.domainLookup, false],
    ['ip domain-lookup', ['no ip domain-lookup', 'ip domain-lookup'], (c) => c.domainLookup, true],
    [
      'interface Loopback creates it',
      ['interface lo0'],
      (c) => c.virtualInterfaces,
      { Loopback0: { shutdown: false } },
    ],
    [
      'no interface Loopback',
      ['interface lo0', 'exit', 'no interface lo0'],
      (c) => c.virtualInterfaces,
      {},
    ],
    [
      'ip route via an address',
      ['ip route 0.0.0.0 0.0.0.0 10.0.0.2'],
      (c) => c.staticRoutes,
      [{ ...route0, nextHop: { kind: 'address', address: '10.0.0.2' } }],
    ],
    [
      'ip route via an interface, with a distance',
      ['ip route 172.16.0.0 255.255.0.0 s0/0/0 5'],
      (c) => c.staticRoutes,
      [
        {
          prefix: { address: '172.16.0.0', prefixLength: 16 },
          nextHop: { kind: 'interface', interface: 'Serial0/0/0' },
          distance: 5,
        },
      ],
    ],
    [
      'ip route to the same next hop replaces the distance',
      ['ip route 0.0.0.0 0.0.0.0 10.0.0.2 7', 'ip route 0.0.0.0 0.0.0.0 10.0.0.2 1'],
      (c) => c.staticRoutes,
      [{ ...route0, nextHop: { kind: 'address', address: '10.0.0.2' } }],
    ],
    [
      'no ip route with a next hop removes that route only',
      [
        'ip route 0.0.0.0 0.0.0.0 10.0.0.2',
        'ip route 0.0.0.0 0.0.0.0 10.0.0.6',
        'no ip route 0.0.0.0 0.0.0.0 10.0.0.2',
      ],
      (c) => c.staticRoutes,
      [{ ...route0, nextHop: { kind: 'address', address: '10.0.0.6' } }],
    ],
    [
      'no ip route without a next hop removes every route to the prefix',
      [
        'ip route 0.0.0.0 0.0.0.0 10.0.0.2',
        'ip route 0.0.0.0 0.0.0.0 s0/0/0',
        'no ip route 0.0.0.0 0.0.0.0',
      ],
      (c) => c.staticRoutes,
      [],
    ],
    ['version is accepted and ignored', ['version 15.4'], (c) => c.unknownLines, []],
    [
      'a sub-mode falls back to global commands',
      ['interface g0/0', 'hostname R2'],
      (c) => c.hostname,
      'R2',
    ],
  ])('router: %s', (_name, lines, read, expected) => {
    expect(r(lines, read)).toEqual(expected);
  });

  it.each<[string, string[], (c: SwitchConfig) => unknown, unknown]>([
    [
      'ip default-gateway',
      ['ip default-gateway 192.168.1.1'],
      (c) => c.defaultGateway,
      '192.168.1.1',
    ],
    [
      'no ip default-gateway',
      ['ip default-g 192.168.1.1', 'no ip default-g'],
      (c) => c.defaultGateway,
      undefined,
    ],
    ['no hostname', ['hostname A', 'no hostname'], (c) => c.hostname, 'Switch'],
  ])('switch: %s', (_name, lines, read, expected) => {
    expect(s(lines, read)).toEqual(expected);
  });
});

describe('interface config commands', () => {
  it.each<[string, string[], (c: RouterConfig) => unknown, unknown]>([
    [
      'ip address',
      ['int g0/0', 'ip address 192.168.1.1 255.255.255.0'],
      (c) => g00(c)?.ipv4,
      { address: '192.168.1.1', prefixLength: 24 },
    ],
    [
      'no ip address',
      ['int g0/0', 'ip add 192.168.1.1 255.255.255.0', 'no ip add'],
      (c) => g00(c)?.ipv4,
      undefined,
    ],
    ['no shutdown', ['int g0/0', 'no shutdown'], (c) => g00(c)?.shutdown, false],
    ['shutdown', ['int g0/0', 'no shut', 'shut'], (c) => g00(c)?.shutdown, true],
    [
      'description',
      ['int g0/0', 'description Link to SW1'],
      (c) => g00(c)?.description,
      'Link to SW1',
    ],
    ['no description', ['int g0/0', 'desc x', 'no desc'], (c) => g00(c)?.description, undefined],
    [
      'clock rate on a serial port',
      ['int s0/0/0', 'clock rate 64000'],
      (c) => s000(c)?.clockRate,
      64000,
    ],
    [
      'no clock rate',
      ['int s0/0/0', 'clock rate 64000', 'no clock rate'],
      (c) => s000(c)?.clockRate,
      undefined,
    ],
    ['speed', ['int g0/0', 'speed 100'], (c) => g00(c)?.speed, 100],
    ['speed auto', ['int g0/0', 'speed 100', 'speed auto'], (c) => g00(c)?.speed, undefined],
    ['no speed', ['int g0/0', 'speed 10', 'no speed'], (c) => g00(c)?.speed, undefined],
    ['duplex', ['int g0/0', 'duplex half'], (c) => g00(c)?.duplex, 'half'],
    ['no duplex', ['int g0/0', 'duplex full', 'no duplex'], (c) => g00(c)?.duplex, undefined],
    [
      'ip address on a loopback',
      ['int lo1', 'ip add 9.9.9.9 255.255.255.255'],
      (c) => c.virtualInterfaces['Loopback1' as never],
      { shutdown: false, ipv4: { address: '9.9.9.9', prefixLength: 32 } },
    ],
    [
      'interface range',
      ['interface range g0/0 - 1', 'no shutdown'],
      (c) => [g00(c)?.shutdown, c.interfaces['GigabitEthernet0/1' as never]?.shutdown],
      [false, false],
    ],
  ])('router: %s', (_name, lines, read, expected) => {
    expect(r(lines, read)).toEqual(expected);
  });

  it.each<[string, string[], (c: SwitchConfig) => unknown, unknown]>([
    [
      'ip address on a VLAN interface',
      ['int vlan 1', 'ip address 192.168.1.2 255.255.255.0', 'no shut'],
      (c) => c.virtualInterfaces['Vlan1' as never],
      { shutdown: false, ipv4: { address: '192.168.1.2', prefixLength: 24 } },
    ],
    [
      'switchport access vlan',
      ['int f0/1', 'switchport access vlan 10'],
      f01,
      { shutdown: false, switchport: { mode: 'access', vlan: 10 } },
    ],
    [
      'access vlan creates the VLAN',
      ['int f0/1', 'sw acc vl 30'],
      (c) => c.vlans[30 as never],
      { name: 'VLAN0030' },
    ],
    [
      'no switchport access vlan',
      ['int f0/1', 'sw acc vl 10', 'no sw acc vl'],
      (c) => f01(c)?.switchport,
      { mode: 'access', vlan: 1 },
    ],
    [
      'switchport mode trunk',
      ['int g0/1', 'switchport mode trunk'],
      (c) => g01(c)?.switchport,
      { mode: 'trunk', nativeVlan: 1 },
    ],
    [
      'trunk native vlan',
      ['int g0/1', 'sw mode trunk', 'switchport trunk native vlan 99'],
      (c) => g01(c)?.switchport,
      { mode: 'trunk', nativeVlan: 99 },
    ],
    [
      'an access port keeps a native VLAN for later',
      ['int g0/1', 'sw trunk native vlan 99'],
      (c) => g01(c)?.switchport,
      { mode: 'access', vlan: 1, nativeVlan: 99 },
    ],
    [
      'switching to trunk keeps the access VLAN',
      ['int g0/1', 'sw acc vl 10', 'sw trunk nat vl 99', 'sw mode trunk'],
      (c) => g01(c)?.switchport,
      { mode: 'trunk', nativeVlan: 99, accessVlan: 10 },
    ],
    [
      'no switchport mode returns to access',
      ['int g0/1', 'sw acc vl 10', 'sw mode trunk', 'no sw mode'],
      (c) => g01(c)?.switchport,
      { mode: 'access', vlan: 10 },
    ],
    ['speed 1000 on a gigabit port', ['int g0/1', 'speed 1000'], (c) => g01(c)?.speed, 1000],
  ])('switch: %s', (_name, lines, read, expected) => {
    expect(s(lines, read)).toEqual(expected);
  });
});

describe('line config commands', () => {
  const con = (c: RouterConfig) => c.lines.console;
  const vty = (n: number) => (c: RouterConfig) => c.lines.vty[n];
  const both = { ssh: true, telnet: true };

  it.each<[string, string[], (c: RouterConfig) => unknown, unknown]>([
    [
      'password',
      ['line con 0', 'password cisco'],
      con,
      { password: 'cisco', login: 'none', transportInput: both },
    ],
    ['password 7', ['line con 0', 'password 7 0822455D0A16'], (c) => con(c).password, 'cisco'],
    [
      'no password',
      ['line con 0', 'password cisco', 'no password'],
      (c) => con(c).password,
      undefined,
    ],
    ['login', ['line con 0', 'login'], (c) => con(c).login, 'password'],
    ['login local', ['line con 0', 'login local'], (c) => con(c).login, 'local'],
    ['no login', ['line vty 0 4', 'no login'], (c) => vty(0)(c)?.login, 'none'],
    ['line aux 0', ['line aux 0', 'password aux'], (c) => c.lines.aux.password, 'aux'],
    [
      'line vty 0 4 sets lines 0 to 4 only',
      ['line vty 0 4', 'password remote'],
      (c) => c.lines.vty.map((l) => l.password ?? null),
      [...Array(5).fill('remote'), ...Array(11).fill(null)],
    ],
    [
      'line vty with one number',
      ['line vty 7', 'password seven'],
      (c) => vty(7)(c)?.password,
      'seven',
    ],
    [
      'transport input ssh',
      ['line vty 0 4', 'transport input ssh'],
      (c) => vty(4)(c)?.transportInput,
      { ssh: true, telnet: false },
    ],
    [
      'transport input telnet ssh',
      ['line vty 0 4', 'transport input none', 'transport input telnet ssh'],
      (c) => vty(0)(c)?.transportInput,
      both,
    ],
    [
      'transport input none',
      ['line vty 0 4', 'transport input none'],
      (c) => vty(0)(c)?.transportInput,
      { ssh: false, telnet: false },
    ],
    [
      'transport input all',
      ['line vty 0 4', 'transport input none', 'transport input all'],
      (c) => vty(0)(c)?.transportInput,
      both,
    ],
    [
      'no transport input',
      ['line vty 0 4', 'transport input none', 'no transport input'],
      (c) => vty(0)(c)?.transportInput,
      both,
    ],
  ])('%s', (_name, lines, read, expected) => {
    expect(r(lines, read)).toEqual(expected);
  });
});

describe('refused commands', () => {
  it.each<[string, 'router' | 'switch', string[], readonly string[]]>([
    ['an interface the device lacks', 'router', ['interface g0/9'], [INVALID_INPUT]],
    [
      'a network address',
      'router',
      ['int g0/0', 'ip add 10.0.0.0 255.255.255.0'],
      ['Bad mask /24 for address 10.0.0.0'],
    ],
    [
      'a broadcast address',
      'router',
      ['int g0/0', 'ip add 10.0.0.255 255.255.255.0'],
      ['Bad mask /24 for address 10.0.0.255'],
    ],
    [
      'an overlapping subnet',
      'router',
      ['int g0/0', 'ip add 10.0.0.1 255.255.255.0', 'int g0/1', 'ip add 10.0.0.2 255.255.0.0'],
      ['% 10.0.0.0 overlaps with GigabitEthernet0/0'],
    ],
    ['clock rate on an Ethernet port', 'router', ['int g0/0', 'clock rate 64000'], [INVALID_INPUT]],
    [
      'a clock rate serial ports do not offer',
      'router',
      ['int s0/0/0', 'clock rate 1234'],
      ['% Invalid clock rate'],
    ],
    ['speed on a serial port', 'router', ['int s0/0/0', 'speed 100'], [INVALID_INPUT]],
    [
      'a route with host bits set',
      'router',
      ['ip route 10.0.0.1 255.0.0.0 1.1.1.1'],
      ['%Inconsistent address and mask'],
    ],
    [
      'a route via an interface the device lacks',
      'router',
      ['ip route 10.0.0.0 255.0.0.0 g0/9'],
      [INVALID_INPUT],
    ],
    [
      'removing a route that is not there',
      'router',
      ['no ip route 9.0.0.0 255.0.0.0'],
      ['%No matching route to delete'],
    ],
    [
      'a hostname IOS refuses',
      'router',
      ['hostname 1st-floor'],
      ['% Hostname contains one or more illegal characters.'],
    ],
    [
      'removing a physical interface',
      'router',
      ['no interface g0/0'],
      ['% Removal of physical interfaces is not permitted'],
    ],
    ['a bad type 7 password', 'router', ['enable password 7 zz'], ['Invalid encrypted password']],
    [
      'a bad type 5 secret',
      'router',
      ['enable secret 5 notahash'],
      ['ERROR: The secret you entered is not a valid encrypted secret.'],
    ],
    ['a backwards vty range', 'router', ['line vty 4 1'], ['%Invalid line range']],
    [
      'transport input all with a second protocol',
      'router',
      ['line vty 0', 'transport input all ssh'],
      [INVALID_INPUT],
    ],
    [
      'ip address on a switchport',
      'switch',
      ['int f0/1', 'ip address 10.0.0.1 255.0.0.0'],
      [INVALID_INPUT],
    ],
    ['speed 1000 on a FastEthernet port', 'switch', ['int f0/1', 'speed 1000'], [INVALID_INPUT]],
    [
      'switchport commands on a VLAN interface',
      'switch',
      ['int vlan 1', 'switchport mode trunk'],
      [INVALID_INPUT],
    ],
  ])('refuses %s', (_name, kind, lines, expected) => {
    const c = consoleOn(kind === 'router' ? router() : switchDevice());
    c.runAll([...ENTER, ...lines.slice(0, -1)]);
    const before = c.device;
    const { pastStates } = c.store.temporal.getState();

    expect(c.run(lines.at(-1)!)).toEqual(expected);
    expect(c.device).toBe(before);
    expect(c.store.temporal.getState().pastStates).toHaveLength(pastStates.length);
  });

  it('stays in the old mode when it refuses to enter an interface', () => {
    const c = consoleOn(router());
    c.runAll([...ENTER, 'interface g0/9']);

    expect(c.prompt).toBe('Router(config)#');
  });

  it('has no aux line or static routes on a switch, and no default gateway on a router', () => {
    for (const [device, line] of [
      [switchDevice(), 'line aux 0'],
      [switchDevice(), 'ip route 0.0.0.0 0.0.0.0 1.1.1.1'],
      [router(), 'ip default-gateway 1.1.1.1'],
    ] as const) {
      const c = consoleOn(device);
      c.runAll(ENTER);
      expect(c.run(line)).toContain(INVALID_INPUT);
    }
  });
});

describe('EXEC commands', () => {
  it('moves between EXEC and config modes', () => {
    const c = consoleOn(router());
    const prompts = [
      'enable',
      'configure terminal',
      'interface g0/0',
      'line vty 0 4',
      'exit',
      'end',
      'disable',
    ].map((line) => {
      c.run(line);
      return c.prompt;
    });

    expect(prompts).toEqual([
      'Router#',
      'Router(config)#',
      'Router(config-if)#',
      'Router(config-line)#',
      'Router(config)#',
      'Router#',
      'Router>',
    ]);
  });

  it.each(['write memory', 'write', 'copy running-config startup-config', 'copy run start'])(
    '%s saves the running-config as the startup-config',
    (save) => {
      const c = consoleOn(router());
      c.runAll(['enable', 'conf t', 'hostname Saved', 'end']);

      const output = c.run(save);

      expect(output.slice(-2)).toEqual(['Building configuration...', '[OK]']);
      expect(c.device.config.startupConfig).toEqual(runningConfig(c.device));
    },
  );

  it('saves from config mode with do', () => {
    const c = consoleOn(router());
    c.runAll([...ENTER, 'hostname Saved', 'do wr']);

    expect(c.device.config.startupConfig).toContain('hostname Saved');
  });

  it('asks for the enable secret, and gives up after three wrong tries', () => {
    const c = consoleOn(router());
    c.runAll([...ENTER, 'enable secret class', 'enable password cisco', 'end', 'disable']);

    c.run('enable');
    expect([c.prompt, c.session.readingPassword]).toEqual(['Password: ', true]);
    c.run('cisco');
    expect(c.prompt).toBe('Password: ');
    c.run('class');
    expect([c.prompt, c.session.readingPassword]).toEqual(['Router#', false]);

    c.run('disable');
    c.run('enable');
    expect(['a', 'b', 'c'].flatMap((guess) => c.run(guess))).toEqual(['% Bad secrets']);
    expect(c.prompt).toBe('Router>');
  });

  it('asks for the enable password when there is no secret', () => {
    const c = consoleOn(router());
    c.runAll([...ENTER, 'enable password cisco', 'end', 'disable', 'enable', 'cisco']);

    expect(c.prompt).toBe('Router#');
  });

  it('enables without a password when none is set', () => {
    const c = consoleOn(router());
    c.run('enable');

    expect(c.prompt).toBe('Router#');
  });

  it('reads banner text until the delimiter, with an empty prompt', () => {
    const c = consoleOn(router());
    c.runAll(ENTER);

    expect(c.run('banner motd #')).toEqual(["Enter TEXT message.  End with the character '#'."]);
    expect(c.prompt).toBe('');
    c.run('Hello');
    c.run('#');
    expect(c.prompt).toBe('Router(config)#');
    expect(c.device.config.bannerMotd).toBe('\nHello\n');
  });
});

describe('undo', () => {
  it('undoes one console line at a time through the editor store', () => {
    const c = consoleOn(router());
    c.runAll([...ENTER, 'hostname First', 'hostname Second', 'interface g0/0', 'show']);

    c.store.getState().undo();
    expect(c.device.config.hostname).toBe('First');
    c.store.getState().undo();
    expect(c.device.config.hostname).toBe('Router');
  });

  it('adds no history for lines that change nothing', () => {
    const c = consoleOn(router());
    c.runAll([...ENTER, 'interface g0/0', 'shutdown', 'exit', 'do show ip interface brief']);

    expect(c.store.temporal.getState().pastStates).toHaveLength(0);
  });
});
