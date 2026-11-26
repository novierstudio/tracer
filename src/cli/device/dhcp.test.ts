import { describe, expect, it } from 'vitest';
import type { RouterConfig } from '../../model';
import { applyLines, withBlankConfig } from './session';
import { runningConfig } from './show';
import { consoleOn, router } from './testing';

const ENTER = ['enable', 'configure terminal'];

/** A console on a new router, in global config mode. */
function configure(lines: readonly string[] = []) {
  const c = consoleOn(router());
  const output = c.runAll([...ENTER, ...lines]);
  return { c, output: output.slice(1) };
}

const dhcpOf = (lines: readonly string[]): RouterConfig['dhcp'] =>
  configure(lines).c.device.config.dhcp;

describe('ip dhcp pool', () => {
  it('enters the pool and builds it from network, default-router, dns-server and lease', () => {
    const { c } = configure(['ip dhcp pool LAN']);
    expect(c.prompt).toBe('Router(dhcp-config)#');
    c.runAll([
      'network 192.168.1.0 255.255.255.0',
      'default-router 192.168.1.1',
      'dns-server 8.8.8.8 8.8.4.4',
      'lease 0 8',
    ]);
    expect(c.device.config.dhcp).toEqual({
      pools: {
        LAN: {
          network: { address: '192.168.1.0', prefixLength: 24 },
          defaultRouters: ['192.168.1.1'],
          dnsServers: ['8.8.8.8', '8.8.4.4'],
          lease: 480,
        },
      },
      excluded: [],
    });
    expect(c.run('exit')).toEqual([]);
    expect(c.prompt).toBe('Router(config)#');
  });

  it('keeps the network number when given a host address', () => {
    const dhcp = dhcpOf(['ip dhcp pool LAN', 'network 10.1.2.77 255.255.255.0']);
    expect(dhcp?.pools.LAN?.network).toEqual({ address: '10.1.2.0', prefixLength: 24 });
  });

  it('takes up to eight addresses on one line, and offers the next one after each', () => {
    const { c } = configure(['ip dhcp pool LAN']);
    const eight = Array.from({ length: 8 }, (_, n) => `10.0.0.${n + 1}`);
    c.run(`default-router ${eight.join(' ')}`);
    expect(c.device.config.dhcp?.pools.LAN?.defaultRouters).toEqual(eight);
    expect(c.run(`dns-server ${[...eight, '10.0.0.9'].join(' ')}`)).toContain(
      "% Invalid input detected at '^' marker.",
    );
    expect(c.session.help(c.device, 'default-router 10.0.0.1 ').join('\n')).toMatch(/A\.B\.C\.D/);
  });

  it.each([
    ['lease infinite', 'infinite'],
    ['lease 7', 7 * 1440],
    ['lease 0 0 30', 30],
    ['lease 2 12 30', 2 * 1440 + 12 * 60 + 30],
    // One day is the default, so it is stored as none.
    ['lease 1', undefined],
  ])('reads %s', (line, lease) => {
    expect(dhcpOf(['ip dhcp pool LAN', line])?.pools.LAN?.lease).toBe(lease);
  });

  it('refuses a lease of no time at all', () => {
    const { c, output } = configure(['ip dhcp pool LAN', 'lease 0']);
    expect(output).toEqual(['% A lease must last at least 1 minute']);
    expect(c.device.config.dhcp?.pools.LAN?.lease).toBeUndefined();
  });

  it('undoes each setting with no', () => {
    const dhcp = dhcpOf([
      'ip dhcp pool LAN',
      'network 192.168.1.0 255.255.255.0',
      'default-router 192.168.1.1',
      'dns-server 8.8.8.8',
      'lease infinite',
      'no network',
      'no default-router',
      'no dns-server',
      'no lease',
    ]);
    expect(dhcp?.pools.LAN).toEqual({});
  });

  it('removes a pool, and the DHCP config with the last one', () => {
    const { c, output } = configure([
      'ip dhcp pool LAN',
      'exit',
      'no ip dhcp pool LAN',
      'no ip dhcp pool LAN',
    ]);
    expect(output).toEqual(['%Pool LAN does not exist']);
    expect(c.device.config.dhcp).toBeUndefined();
  });
});

describe('ip dhcp excluded-address', () => {
  it('keeps single addresses and ranges in the order they were entered', () => {
    const dhcp = dhcpOf([
      'ip dhcp excluded-address 192.168.1.1 192.168.1.10',
      'ip dhcp excluded-address 192.168.1.254',
      'ip dhcp excluded-address 192.168.1.254',
    ]);
    expect(dhcp?.excluded).toEqual([
      { first: '192.168.1.1', last: '192.168.1.10' },
      { first: '192.168.1.254', last: '192.168.1.254' },
    ]);
  });

  it('refuses a range that runs backwards', () => {
    const { output } = configure(['ip dhcp excluded-address 192.168.1.10 192.168.1.1']);
    expect(output).toEqual(['% Invalid address range']);
  });

  it('removes the range named in full with no', () => {
    const dhcp = dhcpOf([
      'ip dhcp excluded-address 192.168.1.1 192.168.1.10',
      'ip dhcp excluded-address 192.168.1.254',
      'ip dhcp pool LAN',
      'no ip dhcp excluded-address 192.168.1.1 192.168.1.10',
      'no ip dhcp excluded-address 192.168.1.254',
    ]);
    expect(dhcp?.excluded).toEqual([]);
  });
});

describe('ip helper-address', () => {
  it('adds each address once to an interface or a subinterface, and removes them with no', () => {
    const { c } = configure([
      'interface g0/0',
      'ip helper-address 10.0.0.1',
      'ip helper-address 10.0.0.2',
      'ip helper-address 10.0.0.1',
      'interface g0/1.10',
      'encapsulation dot1Q 10',
      'ip helper-address 10.0.0.1',
    ]);
    const { interfaces, subinterfaces } = c.device.config;
    expect(interfaces['GigabitEthernet0/0' as never]).toMatchObject({
      helperAddresses: ['10.0.0.1', '10.0.0.2'],
    });
    expect(subinterfaces['GigabitEthernet0/1.10' as never]).toMatchObject({
      helperAddresses: ['10.0.0.1'],
    });
    c.runAll(['interface g0/0', 'no ip helper-address 10.0.0.1']);
    expect(c.device.config.interfaces['GigabitEthernet0/0' as never]).toMatchObject({
      helperAddresses: ['10.0.0.2'],
    });
    c.run('no ip helper-address');
    expect(c.device.config.interfaces['GigabitEthernet0/0' as never]).not.toHaveProperty(
      'helperAddresses',
    );
  });
});

describe('running-config', () => {
  const configured = () =>
    configure([
      'ip dhcp excluded-address 192.168.1.1 192.168.1.10',
      'ip dhcp excluded-address 192.168.2.1',
      'ip dhcp pool LAN',
      'network 192.168.1.0 255.255.255.0',
      'default-router 192.168.1.1',
      'dns-server 8.8.8.8 8.8.4.4',
      'lease 0 2 30',
      'ip dhcp pool EMPTY',
      'interface g0/1',
      'ip address 192.168.2.1 255.255.255.0',
      'ip helper-address 192.168.1.1',
    ]).c.device;

  it('prints the excluded ranges and pools before the interfaces, and helpers under theirs', () => {
    const lines = runningConfig(configured());
    const from = lines.indexOf('ip dhcp excluded-address 192.168.1.1 192.168.1.10');
    expect(lines.slice(from, from + 12)).toEqual([
      'ip dhcp excluded-address 192.168.1.1 192.168.1.10',
      'ip dhcp excluded-address 192.168.2.1',
      '!',
      'ip dhcp pool LAN',
      ' network 192.168.1.0 255.255.255.0',
      ' default-router 192.168.1.1',
      ' dns-server 8.8.8.8 8.8.4.4',
      ' lease 0 2 30',
      '!',
      'ip dhcp pool EMPTY',
      '!',
      '!',
    ]);
    expect(from).toBeLessThan(lines.indexOf('interface GigabitEthernet0/0'));
    const g01 = lines.indexOf('interface GigabitEthernet0/1');
    expect(lines.slice(g01, g01 + 3)).toEqual([
      'interface GigabitEthernet0/1',
      ' ip address 192.168.2.1 255.255.255.0',
      ' ip helper-address 192.168.1.1',
    ]);
  });

  it('rebuilds the same config when replayed on a blank router', () => {
    const device = configured();
    const { config, errors } = applyLines(withBlankConfig(device), runningConfig(device));
    expect(errors).toEqual([]);
    expect(config).toEqual(device.config);
  });

  it.each([
    ['lease 7', ' lease 7'],
    ['lease 0 12', ' lease 0 12'],
    ['lease 0 0 1', ' lease 0 0 1'],
    ['lease infinite', ' lease infinite'],
  ])('writes %s back as it was typed', (typed, printed) => {
    const lines = runningConfig(configure(['ip dhcp pool LAN', typed]).c.device);
    expect(lines).toContain(printed);
  });
});
