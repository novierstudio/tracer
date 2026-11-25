import { describe, expect, it } from 'vitest';
import branchRouter from './__fixtures__/branch-router.txt?raw';
import ptRouter from './__fixtures__/pt7.1-eigrp-lab-R1.txt?raw';
import ptSwitch from './__fixtures__/pt8.2-vtp-lab-SW1.txt?raw';
import type { IosDevice } from './context';
import { verifySecret } from '../passwords';
import { applyLines, withBlankConfig } from './session';
import { runningConfig } from './show';
import { consoleOn, router, switchDevice } from './testing';

const linesOf = (text: string) => text.trimEnd().split('\n');

/** What a .pkt import does: replay the running-config onto a blank device. */
function load<D extends IosDevice>(device: D, text: string) {
  const blank = withBlankConfig(device);
  const { config, errors } = applyLines(blank, linesOf(text));
  return { device: { ...blank, config } as D, errors };
}

function roundTrip<D extends IosDevice>(device: D) {
  return applyLines(withBlankConfig(device), runningConfig(device));
}

const PT_ROUTER_PORTS = ['GigabitEthernet0/0/0', 'GigabitEthernet0/0/1'];
const BRANCH_PORTS = ['GigabitEthernet0/0', 'GigabitEthernet0/1', 'Serial0/0/0', 'Serial0/0/1'];

describe('replaying a Packet Tracer running-config', () => {
  it('loads router R1 from a PT 7.1 lab with no errors and keeps what it does not model', () => {
    const { device, errors } = load(router(PT_ROUTER_PORTS), ptRouter);

    expect(errors).toEqual([]);
    const { config } = device;
    expect(config.hostname).toBe('R1');
    expect(config.virtualInterfaces).toEqual({
      Loopback0: { shutdown: false, ipv4: { address: '1.1.1.1', prefixLength: 32 } },
      Vlan1: { shutdown: true },
    });
    expect(config.interfaces).toEqual({
      'GigabitEthernet0/0/0': {
        shutdown: false,
        ipv4: { address: '10.1.1.1', prefixLength: 24 },
      },
      'GigabitEthernet0/0/1': { shutdown: true },
    });
    expect(config.lines.vty.slice(0, 5).every((l) => l.login === 'password')).toBe(true);
    expect(config.lines.vty[5]?.login).toBe('none');
    expect(config.unknownLines).toEqual([
      'no service timestamps log datetime msec',
      'no service timestamps debug datetime msec',
      'ip cef',
      'no ipv6 cef',
      'spanning-tree mode pvst',
      'ip classless',
      'ip flow-export version 9',
    ]);
  });

  it('loads switch SW1 from a PT 8.2 lab with no errors', () => {
    const { device, errors } = load(switchDevice(), ptSwitch);

    expect(errors).toEqual([]);
    expect(device.config.hostname).toBe('SW1');
    expect(device.config.virtualInterfaces).toEqual({ Vlan1: { shutdown: true } });
    expect(device.config.lines.vty.every((l) => l.login === 'password')).toBe(true);
    expect(device.config.unknownLines).toEqual([
      'no service timestamps log datetime msec',
      'no service timestamps debug datetime msec',
    ]);
  });

  it('loads a lab router config that uses every supported command', () => {
    const { device, errors } = load(router(BRANCH_PORTS), branchRouter);

    expect(errors).toEqual([]);
    const { config } = device;
    expect(config).toMatchObject({
      hostname: 'Branch-R1',
      servicePasswordEncryption: true,
      domainLookup: false,
      enableSecret: '$1$mERr$hx5rVt7rPNoS4wqbXKX7m0',
      enablePassword: 'cisco',
      bannerMotd: '\nAuthorized access only.\nDisconnect now if you are not an authorized user.\n',
      staticRoutes: [
        {
          prefix: { address: '0.0.0.0', prefixLength: 0 },
          nextHop: { kind: 'address', address: '10.0.0.2' },
        },
        {
          prefix: { address: '172.16.0.0', prefixLength: 16 },
          nextHop: { kind: 'interface', interface: 'Serial0/0/0' },
          distance: 5,
        },
      ],
    });
    expect(verifySecret('cisco', config.enableSecret!)).toBe(true);
    expect(config.interfaces['GigabitEthernet0/0' as never]).toEqual({
      shutdown: false,
      description: 'LAN to SW1',
      ipv4: { address: '192.168.10.1', prefixLength: 24 },
      duplex: 'full',
      speed: 100,
    });
    expect(config.interfaces['Serial0/0/0' as never]).toMatchObject({ clockRate: 64000 });
    expect(config.lines.console).toEqual({
      password: 'cisco',
      login: 'password',
      transportInput: { ssh: true, telnet: true },
    });
    expect(config.lines.vty[0]).toEqual({
      password: 'cisco',
      login: 'local',
      transportInput: { ssh: true, telnet: false },
    });
    expect(config.lines.vty[15]).toEqual({
      login: 'password',
      transportInput: { ssh: false, telnet: false },
    });
    expect(config.unknownLines).toEqual([
      'no service timestamps log datetime msec',
      'no service timestamps debug datetime msec',
      'ip cef',
      'no ipv6 cef',
      'username admin secret 5 $1$mERr$hx5rVt7rPNoS4wqbXKX7m0',
      'license udi pid CISCO2911/K9 sn FTX1524X8M2-',
      'spanning-tree mode pvst',
      'interface GigabitEthernet0/0',
      ' ip nat inside',
      'interface Serial0/0/0',
      ' ip nat outside',
      'router ospf 1',
      ' log-adjacency-changes',
      ' network 192.168.10.0 0.0.0.255 area 0',
      ' network 10.0.0.0 0.0.0.3 area 0',
      'ip nat inside source list 1 interface Serial0/0/0 overload',
      'ip classless',
      'ip flow-export version 9',
      'access-list 1 permit 192.168.10.0 0.0.0.255',
      'line con 0',
      ' logging synchronous',
      'line vty 0 4',
      ' exec-timeout 5 0',
    ]);
  });

  it('reports lines the device refuses, and keeps them with their block', () => {
    const { device, errors } = load(
      router(['GigabitEthernet0/0']),
      [
        'hostname R9',
        'interface GigabitEthernet0/5',
        ' ip address 10.0.0.1 255.255.255.0',
        '!',
        'interface GigabitEthernet0/0',
        ' ip address 10.0.0.1 255.255.255.0',
      ].join('\n'),
    );

    expect(errors).toEqual([
      {
        line: 2,
        text: 'interface GigabitEthernet0/5',
        message: "% Invalid input detected at '^' marker.",
      },
    ]);
    expect(device.config.unknownLines).toEqual([
      'interface GigabitEthernet0/5',
      ' ip address 10.0.0.1 255.255.255.0',
    ]);
    expect(device.config.hostname).toBe('R9');
    expect(device.config.interfaces['GigabitEthernet0/0' as never]).toMatchObject({
      ipv4: { address: '10.0.0.1', prefixLength: 24 },
    });
  });

  it('reports a banner that never closes', () => {
    expect(load(router(), 'banner motd #\nnever closed').errors).toEqual([
      { line: 2, text: '', message: 'The banner is missing its closing delimiter' },
    ]);
  });
});

describe('round-trip: config, show running-config, replay on a blank device', () => {
  const configuredRouter = () => {
    const c = consoleOn(router(BRANCH_PORTS));
    c.runAll([
      'enable',
      'configure terminal',
      'hostname Edge',
      'enable secret class',
      'enable password cisco',
      'service password-encryption',
      'no ip domain-lookup',
      'banner motd #',
      'Welcome to Edge',
      '#',
      'interface loopback 0',
      'ip address 2.2.2.2 255.255.255.255',
      'interface g0/0',
      'description Users',
      'ip address 192.168.1.1 255.255.255.0',
      'duplex half',
      'speed 10',
      'no shutdown',
      'interface s0/0/0',
      'ip address 10.0.0.1 255.255.255.252',
      'clock rate 128000',
      'no shutdown',
      'exit',
      'ip route 0.0.0.0 0.0.0.0 10.0.0.2',
      'ip route 10.9.0.0 255.255.0.0 s0/0/0 200',
      'line con 0',
      'password console',
      'login',
      'line vty 0 4',
      'password remote',
      'login local',
      'transport input ssh telnet',
      'line vty 5 15',
      'transport input none',
      'end',
      'write memory',
    ]);
    return c.device;
  };

  const configuredSwitch = () => {
    const c = consoleOn(switchDevice());
    c.runAll([
      'enable',
      'configure terminal',
      'hostname Access-SW',
      'enable secret 5 $1$mERr$hx5rVt7rPNoS4wqbXKX7m0',
      'interface vlan 1',
      'ip address 192.168.1.2 255.255.255.0',
      'no shutdown',
      'exit',
      'ip default-gateway 192.168.1.1',
      'interface range f0/1 - 4',
      'switchport access vlan 10',
      'interface f0/5',
      'switchport mode trunk',
      'switchport trunk native vlan 99',
      'interface f0/6',
      'switchport trunk native vlan 98',
      'interface g0/1',
      'switchport mode trunk',
      'switchport access vlan 20',
      'speed 1000',
      'duplex full',
      'interface f0/24',
      'shutdown',
      'description unused',
      'line vty 0 15',
      'password cisco',
      'login',
      'end',
    ]);
    return c.device;
  };

  it.each<[string, () => IosDevice]>([
    ['a configured router', configuredRouter],
    ['a configured switch', configuredSwitch],
    ['a new router', () => router()],
    ['a new switch', () => switchDevice()],
    ['the PT 7.1 router', () => load(router(PT_ROUTER_PORTS), ptRouter).device],
    ['the PT 8.2 switch', () => load(switchDevice(), ptSwitch).device],
    ['the lab router', () => load(router(BRANCH_PORTS), branchRouter).device],
  ])('rebuilds %s exactly', (_name, build) => {
    const device = build();

    const { config, errors } = roundTrip(device);

    expect(errors).toEqual([]);
    expect(config).toEqual(device.config);
  });

  it('prints the same running-config after the round trip', () => {
    const device = load(router(BRANCH_PORTS), branchRouter).device;
    const again = { ...device, config: roundTrip(device).config };

    expect(runningConfig(again)).toEqual(runningConfig(device));
  });
});
