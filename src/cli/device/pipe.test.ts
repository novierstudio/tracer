import { describe, expect, it } from 'vitest';
import type { Route } from '../../engine/api';
import { consoleOn, router } from './testing';

function configuredRouter() {
  const c = consoleOn(router(['GigabitEthernet0/0', 'GigabitEthernet0/1']));
  c.runAll([
    'enable',
    'configure terminal',
    'hostname R1',
    'interface g0/0',
    'description LAN',
    'ip address 192.168.1.1 255.255.255.0',
    'no shutdown',
    'line vty 0 4',
    'password cisco',
    'login',
    'end',
  ]);
  return c;
}

describe('output modifiers', () => {
  it('include keeps the lines that match', () => {
    expect(configuredRouter().run('show running-config | include interface')).toEqual([
      'interface GigabitEthernet0/0',
      'interface GigabitEthernet0/1',
    ]);
  });

  it('accepts abbreviations and a regular expression', () => {
    expect(configuredRouter().run('sh run | i ^line (con|aux)')).toEqual([
      'line con 0',
      'line aux 0',
    ]);
  });

  it('exclude drops the lines that match', () => {
    const output = configuredRouter().run('show running-config | exclude ^!|^ |^$');
    expect(output).toEqual([
      'Building configuration...',
      'Current configuration : 295 bytes',
      'version 15.1',
      'no service password-encryption',
      'hostname R1',
      'interface GigabitEthernet0/0',
      'interface GigabitEthernet0/1',
      'line con 0',
      'line aux 0',
      'line vty 0 4',
      'line vty 5 15',
      'end',
    ]);
  });

  it('begin starts at the first line that matches', () => {
    expect(configuredRouter().run('show running-config | begin line vty')).toEqual([
      'line vty 0 4',
      ' password cisco',
      ' login',
      'line vty 5 15',
      ' login',
      '!',
      'end',
    ]);
  });

  it('section keeps each matching line and the lines indented under it', () => {
    expect(configuredRouter().run('show running-config | section interface')).toEqual([
      'interface GigabitEthernet0/0',
      ' description LAN',
      ' ip address 192.168.1.1 255.255.255.0',
      'interface GigabitEthernet0/1',
      ' no ip address',
      ' shutdown',
    ]);
    expect(configuredRouter().run('show running-config | section vty 0')).toEqual([
      'line vty 0 4',
      ' password cisco',
      ' login',
    ]);
  });

  it('prints nothing when no line matches', () => {
    expect(configuredRouter().run('show running-config | include ospf')).toEqual([]);
  });

  it('filters the live output of a show command that asks the simulation', () => {
    const c = configuredRouter();
    const { output, query } = c.session.run(c.device, 'show ip route | include /24');
    expect(query?.kind).toBe('routes');
    expect(output).toEqual([]);

    const routes = [
      { source: 'connected', prefix: { address: '192.168.1.0', prefixLength: 24 } },
      { source: 'local', prefix: { address: '192.168.1.1', prefixLength: 32 } },
    ].map((route) => ({ ...route, interface: 'GigabitEthernet0/0' })) as Route[];
    const render = query!.render as (answer: readonly Route[]) => readonly string[];
    expect(render(routes)).toEqual([
      '      192.168.1.0/24 is variably subnetted, 2 subnets, 2 masks',
      'C        192.168.1.0/24 is directly connected, GigabitEthernet0/0',
    ]);
  });

  it('works from config mode through do', () => {
    const c = configuredRouter();
    c.run('configure terminal');
    expect(c.run('do show running-config | include hostname')).toEqual(['hostname R1']);
  });

  it('refuses a regular expression that does not compile', () => {
    expect(configuredRouter().run('show running-config | include (interface')).toEqual([
      '% Invalid regular expression',
    ]);
  });

  it('marks an unknown modifier and asks for a missing expression', () => {
    const c = configuredRouter();
    // The prompt `R1#` is 3 wide; `count` starts at column 20 of the line.
    expect(c.run('show running-config | count x')).toEqual([
      `${' '.repeat(3 + 22)}^`,
      "% Invalid input detected at '^' marker.",
    ]);
    expect(c.run('show running-config | include')).toEqual(['% Incomplete command.']);
    expect(c.run('show running-config |')).toEqual(['% Incomplete command.']);
  });

  it('leaves a | in config text alone', () => {
    const c = configuredRouter();
    c.runAll(['configure terminal', 'interface g0/1', 'description uplink | core', 'end']);
    expect(c.run('show running-config | include description')).toEqual([
      ' description LAN',
      ' description uplink | core',
    ]);
  });
});

describe('output modifier help', () => {
  it('lists the modifiers after a |', () => {
    const c = configuredRouter();
    expect(c.session.help(c.device, 'show running-config | ')).toEqual([
      '  begin    Begin with the line that matches',
      '  exclude  Exclude lines that match',
      '  include  Include lines that match',
      '  section  Filter a section of output',
    ]);
    expect(c.session.help(c.device, 'show running-config | include ')).toEqual([
      '  LINE  Regular Expression',
    ]);
    expect(c.session.help(c.device, 'show running-config | e')).toEqual(['exclude']);
  });

  it('offers | at the end of a show command', () => {
    const c = configuredRouter();
    expect(c.session.help(c.device, 'show running-config ')).toEqual([
      '  |     Output modifiers',
      '  <cr>',
    ]);
    expect(c.session.help(c.device, 'configure terminal ')).toEqual(['  <cr>']);
  });

  it('completes a modifier with Tab', () => {
    const c = configuredRouter();
    expect(c.session.complete(c.device, 'show running-config | sec').line).toBe(
      'show running-config | section ',
    );
  });
});
