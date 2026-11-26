import { describe, expect, it } from 'vitest';
import type { NatTranslationEntry } from '../../engine/api';
import type { RouterConfig } from '../../model';
import { applyLines, withBlankConfig } from './session';
import { runningConfig } from './show';
import { showIpNatTranslations } from './showAclNat';
import { consoleOn, router } from './testing';

const ENTER = ['enable', 'configure terminal'];

function configured(lines: readonly string[]) {
  const c = consoleOn(router());
  const output = c.runAll([...ENTER, ...lines]).slice(1);
  return { c, output, config: c.device.config as RouterConfig };
}

const PAT_LAB = [
  'interface g0/0',
  'ip address 192.168.1.1 255.255.255.0',
  'ip nat inside',
  'interface g0/1',
  'ip address 203.0.113.1 255.255.255.0',
  'ip nat outside',
  'exit',
  'access-list 1 permit 192.168.1.0 0.0.0.255',
  'ip nat inside source list 1 interface g0/1 overload',
];

describe('NAT config', () => {
  it('marks interfaces inside and outside, and no takes the role away', () => {
    const { c, config } = configured(PAT_LAB);
    expect(config.interfaces['GigabitEthernet0/0' as never]).toMatchObject({ nat: 'inside' });
    expect(config.interfaces['GigabitEthernet0/1' as never]).toMatchObject({ nat: 'outside' });

    c.runAll(['interface g0/1', 'no ip nat outside']);
    expect(
      (c.device.config as RouterConfig).interfaces['GigabitEthernet0/1' as never],
    ).not.toHaveProperty('nat');
  });

  it('keeps pools, dynamic rules and static mappings', () => {
    const { config } = configured([
      'ip nat pool OUT 192.0.2.10 192.0.2.20 netmask 255.255.255.0',
      'ip nat pool BIG 198.51.100.1 198.51.100.254 prefix-length 24',
      'ip nat inside source list 1 pool OUT',
      'ip nat inside source list 2 pool BIG overload',
      'ip nat inside source list 3 interface g0/1 overload',
      'ip nat inside source static 192.168.1.5 192.0.2.5',
    ]);
    expect(config.nat).toEqual({
      pools: {
        OUT: { first: '192.0.2.10', last: '192.0.2.20', prefixLength: 24 },
        BIG: { first: '198.51.100.1', last: '198.51.100.254', prefixLength: 24 },
      },
      dynamic: [
        { acl: '1', to: { kind: 'pool', pool: 'OUT' }, overload: false },
        { acl: '2', to: { kind: 'pool', pool: 'BIG' }, overload: true },
        {
          acl: '3',
          to: { kind: 'interface', interface: 'GigabitEthernet0/1' },
          overload: true,
        },
      ],
      statics: [{ local: '192.168.1.5', global: '192.0.2.5' }],
    });
  });

  it('keeps one rule per access list: a new one replaces it', () => {
    const { config } = configured([
      'ip nat pool OUT 192.0.2.10 192.0.2.20 netmask 255.255.255.0',
      'ip nat inside source list 1 pool OUT',
      'ip nat inside source list 1 pool OUT overload',
    ]);
    expect(config.nat?.dynamic).toEqual([
      { acl: '1', to: { kind: 'pool', pool: 'OUT' }, overload: true },
    ]);
  });

  it('refuses a pool that spans subnets or runs backwards', () => {
    expect(
      configured(['ip nat pool P 192.0.2.10 192.0.3.20 netmask 255.255.255.0']).output,
    ).toEqual(['%Start and end addresses on different subnets']);
    expect(
      configured(['ip nat pool P 192.0.2.20 192.0.2.10 netmask 255.255.255.0']).output,
    ).toEqual(['%End address less than starting address']);
  });

  it('removes what no names, and the NAT config once it is empty', () => {
    const { config } = configured([
      'ip nat pool OUT 192.0.2.10 192.0.2.20 netmask 255.255.255.0',
      'ip nat inside source list 1 pool OUT',
      'ip nat inside source static 192.168.1.5 192.0.2.5',
      'no ip nat inside source list 1 pool OUT',
      'no ip nat inside source static 192.168.1.5 192.0.2.5',
      'no ip nat pool OUT',
    ]);
    expect(config.nat).toBeUndefined();
  });

  it('writes running-config in IOS order and replays to the same config', () => {
    const { c } = configured([
      ...PAT_LAB,
      'ip nat pool OUT 192.0.2.10 192.0.2.20 netmask 255.255.255.0',
      'ip nat inside source list 2 pool OUT',
      'ip nat inside source static 192.168.1.5 192.0.2.5',
      'ip route 0.0.0.0 0.0.0.0 203.0.113.2',
    ]);
    const running = runningConfig(c.device);

    const at = running.indexOf('interface GigabitEthernet0/0');
    expect(running.slice(at, at + 4)).toEqual([
      'interface GigabitEthernet0/0',
      ' ip address 192.168.1.1 255.255.255.0',
      ' ip nat inside',
      ' shutdown',
    ]);
    const nat = running.indexOf('ip nat pool OUT 192.0.2.10 192.0.2.20 netmask 255.255.255.0');
    expect(running.slice(nat, nat + 8)).toEqual([
      'ip nat pool OUT 192.0.2.10 192.0.2.20 netmask 255.255.255.0',
      'ip nat inside source list 1 interface GigabitEthernet0/1 overload',
      'ip nat inside source list 2 pool OUT',
      'ip nat inside source static 192.168.1.5 192.0.2.5',
      '!',
      'ip route 0.0.0.0 0.0.0.0 203.0.113.2',
      '!',
      'access-list 1 permit 192.168.1.0 0.0.0.255',
    ]);

    const replayed = applyLines(withBlankConfig(c.device), running);
    expect(replayed.errors).toEqual([]);
    expect(replayed.config).toEqual(c.device.config);
  });
});

describe('show ip nat translations', () => {
  const rows: NatTranslationEntry[] = [
    {
      protocol: 1,
      insideGlobal: { address: '203.0.113.1', port: 1 } as never,
      insideLocal: { address: '192.168.1.10', port: 1 } as never,
      outside: { address: '198.51.100.10', port: 1 } as never,
    },
    {
      protocol: 1,
      insideGlobal: { address: '203.0.113.1', port: 1024 } as never,
      insideLocal: { address: '192.168.1.11', port: 1 } as never,
      outside: { address: '198.51.100.10', port: 1024 } as never,
    },
    {
      insideGlobal: { address: '192.0.2.5' } as never,
      insideLocal: { address: '192.168.1.5' } as never,
    },
  ];

  it('prints IOS columns, with --- where an address mapping has no protocol or outside', () => {
    const { c } = configured([]);
    expect(showIpNatTranslations(rows, c.device)).toEqual([
      'Pro  Inside global         Inside local          Outside local         Outside global',
      'icmp 203.0.113.1:1         192.168.1.10:1        198.51.100.10:1       198.51.100.10:1',
      'icmp 203.0.113.1:1024      192.168.1.11:1        198.51.100.10:1024    198.51.100.10:1024',
      '---  192.0.2.5             192.168.1.5           ---                   ---',
    ]);
  });

  it('asks the simulation, and shows static mappings alone without one', () => {
    const { c } = configured(['ip nat inside source static 192.168.1.5 192.0.2.5', 'end']);
    const { output, query } = c.session.run(c.device, 'show ip nat translations');
    expect(query?.kind).toBe('natTranslations');
    expect(output).toEqual([
      'Pro  Inside global         Inside local          Outside local         Outside global',
      '---  192.0.2.5             192.168.1.5           ---                   ---',
    ]);
  });

  it('clears dynamic translations through the simulation', () => {
    const { c } = configured(['end']);
    const { output, query } = c.session.run(c.device, 'clear ip nat translation *');
    expect(query?.kind).toBe('natCleared');
    expect(output).toEqual([]);
  });
});
