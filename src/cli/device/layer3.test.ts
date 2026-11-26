import { describe, expect, it } from 'vitest';
import type { SwitchConfig } from '../../model';
import { INVALID_INPUT } from './context';
import { applyLines, withBlankConfig } from './session';
import { runningConfig } from './show';
import { consoleOn, multilayerSwitch, switchDevice } from './testing';

const ENTER = ['enable', 'configure terminal'];

/** Runs `lines` from global config on a fresh switch: what they print and the config they leave. */
function configured(lines: readonly string[], device = multilayerSwitch()) {
  const c = consoleOn(device);
  const output = c.runAll([...ENTER, ...lines]).slice(1);
  return { c, output, config: c.device.config as SwitchConfig };
}

const port = (config: SwitchConfig, name: string) => config.interfaces[name as never];

/** An L3 switch with two SVIs, a routed uplink, a static default route and DHCP relay. */
const CORE = [
  'hostname Core',
  'ip routing',
  'vlan 10',
  'vlan 20',
  'interface Vlan10',
  ' ip address 192.168.10.1 255.255.255.0',
  ' ip helper-address 10.0.0.2',
  'interface Vlan20',
  ' ip address 192.168.20.1 255.255.255.0',
  'interface GigabitEthernet0/1',
  ' no switchport',
  ' ip address 10.0.0.1 255.255.255.252',
  'exit',
  'ip route 0.0.0.0 0.0.0.0 10.0.0.2',
];

describe('a multilayer switch', () => {
  it('turns ip routing on and off', () => {
    expect(configured(['ip routing']).config.ipRouting).toBe(true);
    expect(configured(['ip routing', 'no ip routing']).config.ipRouting).toBeUndefined();
  });

  it('makes a port routed with no switchport, then gives it an address', () => {
    const { config, output } = configured([
      'interface GigabitEthernet0/1',
      ' no switchport',
      ' ip address 10.0.0.1 255.255.255.252',
    ]);
    expect(output).toEqual([]);
    expect(port(config, 'GigabitEthernet0/1')).toEqual({
      shutdown: false,
      ipv4: { address: '10.0.0.1', prefixLength: 30 },
    });
  });

  it('refuses an address on a port that still switches', () => {
    const { config, output } = configured([
      'interface GigabitEthernet0/1',
      ' ip address 10.0.0.1 255.255.255.252',
    ]);
    expect(output).toEqual([INVALID_INPUT]);
    expect(port(config, 'GigabitEthernet0/1')?.ipv4).toBeUndefined();
  });

  it('brings a routed port back as a VLAN 1 access port that forgets its address', () => {
    const { config } = configured([
      'interface GigabitEthernet0/1',
      ' no switchport',
      ' ip address 10.0.0.1 255.255.255.252',
      ' ip helper-address 10.0.0.9',
      ' switchport',
    ]);
    expect(port(config, 'GigabitEthernet0/1')).toEqual({
      shutdown: false,
      switchport: { mode: 'access', vlan: 1 },
    });
  });

  it('refuses switchport settings on a routed port', () => {
    const { output } = configured([
      'interface FastEthernet0/1',
      ' no switchport',
      ' switchport access vlan 10',
    ]);
    expect(output).toEqual([INVALID_INPUT]);
  });

  it('refuses an address that overlaps a routed port', () => {
    const { output } = configured([
      'interface GigabitEthernet0/1',
      ' no switchport',
      ' ip address 10.0.0.1 255.255.255.0',
      'interface Vlan10',
      ' ip address 10.0.0.2 255.255.255.0',
    ]);
    expect(output).toEqual(['% 10.0.0.0 overlaps with GigabitEthernet0/1']);
  });

  it('keeps static routes and helper addresses on VLAN interfaces', () => {
    const { config, output } = configured(CORE);
    expect(output).toEqual([]);
    expect(config.staticRoutes).toEqual([
      {
        prefix: { address: '0.0.0.0', prefixLength: 0 },
        nextHop: { kind: 'address', address: '10.0.0.2' },
      },
    ]);
    expect(config.virtualInterfaces['Vlan10' as never]?.helperAddresses).toEqual(['10.0.0.2']);
  });

  it('removes a static route with no ip route', () => {
    const { config } = configured([
      'ip route 0.0.0.0 0.0.0.0 10.0.0.2',
      'no ip route 0.0.0.0 0.0.0.0 10.0.0.2',
    ]);
    expect(config.staticRoutes).toEqual([]);
  });

  it('writes its routing config to the running-config', () => {
    const lines = runningConfig(configured(CORE).c.device);
    const block = (name: string) => {
      const start = lines.indexOf(`interface ${name}`);
      return lines.slice(start, lines.indexOf('!', start));
    };
    expect(lines).toContain('ip routing');
    expect(lines).toContain('ip route 0.0.0.0 0.0.0.0 10.0.0.2');
    expect(block('GigabitEthernet0/1')).toEqual([
      'interface GigabitEthernet0/1',
      ' no switchport',
      ' ip address 10.0.0.1 255.255.255.252',
    ]);
    expect(block('Vlan10')).toEqual([
      'interface Vlan10',
      ' ip address 192.168.10.1 255.255.255.0',
      ' ip helper-address 10.0.0.2',
    ]);
  });

  it('rebuilds the same config from its running-config', () => {
    const { device } = configured(CORE).c;
    const { config, errors } = applyLines(withBlankConfig(device), runningConfig(device));
    expect(errors).toEqual([]);
    expect(config).toEqual(device.config);
  });

  it('asks the simulation for its routing table on show ip route once it routes', () => {
    const c = consoleOn(multilayerSwitch());
    c.runAll([...ENTER, 'ip routing', 'end']);
    expect(c.session.run(c.device, 'show ip route').query?.kind).toBe('routes');
  });
});

describe('a layer 2 switch', () => {
  it.each([
    ['ip routing', ['ip routing']],
    ['ip route', ['ip route 0.0.0.0 0.0.0.0 10.0.0.2']],
    ['no switchport', ['interface GigabitEthernet0/1', ' no switchport']],
    ['ip helper-address', ['interface Vlan1', ' ip helper-address 10.0.0.2']],
  ])('refuses %s, as only a multilayer switch routes', (_name, lines) => {
    const { config, output } = configured(lines, switchDevice());
    expect(output).toEqual([INVALID_INPUT]);
    expect(config.ipRouting).toBeUndefined();
    expect(config.staticRoutes).toBeUndefined();
    expect(port(config, 'GigabitEthernet0/1')?.switchport).toBeDefined();
  });

  it('accepts switchport, which changes nothing', () => {
    const { config, output } = configured(
      ['interface FastEthernet0/1', ' switchport'],
      switchDevice(),
    );
    expect(output).toEqual([]);
    expect(port(config, 'FastEthernet0/1')?.switchport).toEqual({ mode: 'access', vlan: 1 });
  });

  it('shows its default gateway for show ip route', () => {
    const c = consoleOn(switchDevice());
    c.run('enable');
    expect(c.run('show ip route')[0]).toBe('Default gateway is not set');
  });
});
