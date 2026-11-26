import { describe, expect, it } from 'vitest';
import type { AclHits } from '../../engine/api';
import type { RouterConfig } from '../../model';
import { applyLines, withBlankConfig } from './session';
import { runningConfig } from './show';
import { showAccessLists } from './showAclNat';
import { consoleOn, multilayerSwitch, router, switchDevice } from './testing';

const ENTER = ['enable', 'configure terminal'];

/** Runs `lines` from global config on a new router and returns its console and what it printed. */
function configured(lines: readonly string[]) {
  const c = consoleOn(router());
  const output = c.runAll([...ENTER, ...lines]).slice(1);
  return { c, output, config: c.device.config as RouterConfig };
}

const any = { address: '0.0.0.0', wildcard: '255.255.255.255' };
const host = (address: string) => ({ address, wildcard: '0.0.0.0' });

describe('access-list', () => {
  it('adds standard entries in order, keeping only the bits the wildcard compares', () => {
    const { config } = configured([
      'access-list 10 remark Sales only',
      'access-list 10 deny host 192.168.1.5',
      'access-list 10 permit 192.168.1.77 0.0.0.255',
      'access-list 10 permit 10.0.0.9',
      'access-list 10 deny any',
    ]);

    expect(config.accessLists).toEqual({
      '10': {
        type: 'standard',
        entries: [
          { kind: 'remark', text: 'Sales only' },
          { kind: 'rule', action: 'deny', source: host('192.168.1.5') },
          {
            kind: 'rule',
            action: 'permit',
            source: { address: '192.168.1.0', wildcard: '0.0.0.255' },
          },
          { kind: 'rule', action: 'permit', source: host('10.0.0.9') },
          { kind: 'rule', action: 'deny', source: any },
        ],
      },
    });
  });

  it('reads extended entries: protocol, addresses, ports by number or name, and ICMP types', () => {
    const { config } = configured([
      'access-list 101 deny tcp 10.1.0.0 0.0.0.255 10.2.0.0 0.0.0.255 eq www',
      'access-list 101 permit udp host 10.1.0.5 range 1024 65535 any eq domain',
      'access-list 101 permit tcp any gt 1023 host 10.2.0.9 neq 23',
      'access-list 101 permit icmp any any echo-reply',
      'access-list 101 permit ip any any',
    ]);

    expect(config.accessLists?.['101']).toEqual({
      type: 'extended',
      entries: [
        {
          kind: 'rule',
          action: 'deny',
          protocol: 'tcp',
          source: { address: '10.1.0.0', wildcard: '0.0.0.255' },
          destination: { address: '10.2.0.0', wildcard: '0.0.0.255' },
          destinationPort: { op: 'eq', port: 80 },
        },
        {
          kind: 'rule',
          action: 'permit',
          protocol: 'udp',
          source: host('10.1.0.5'),
          sourcePort: { op: 'range', first: 1024, last: 65535 },
          destination: any,
          destinationPort: { op: 'eq', port: 53 },
        },
        {
          kind: 'rule',
          action: 'permit',
          protocol: 'tcp',
          source: any,
          sourcePort: { op: 'gt', port: 1023 },
          destination: host('10.2.0.9'),
          destinationPort: { op: 'neq', port: 23 },
        },
        {
          kind: 'rule',
          action: 'permit',
          protocol: 'icmp',
          source: any,
          destination: any,
          icmpType: 'echo-reply',
        },
        { kind: 'rule', action: 'permit', protocol: 'ip', source: any, destination: any },
      ],
    });
  });

  it('takes unique abbreviations, as IOS does', () => {
    const { config } = configured(['access-list 120 per tc h 10.0.0.1 a eq 80']);
    expect(config.accessLists?.['120']?.entries).toEqual([
      {
        kind: 'rule',
        action: 'permit',
        protocol: 'tcp',
        source: host('10.0.0.1'),
        destination: any,
        destinationPort: { op: 'eq', port: 80 },
      },
    ]);
  });

  it.each<[string, string]>([
    ['a port on ICMP', 'access-list 101 permit icmp any any eq 80'],
    ['a wildcard missing in an extended entry', 'access-list 101 permit ip 10.0.0.0 any'],
    ['an unknown protocol', 'access-list 101 permit gre any any'],
    ['a range that runs backwards', 'access-list 101 permit udp any any range 90 80'],
    ['a port past 65535', 'access-list 101 permit udp any any eq 70000'],
    ['an extended entry in a standard list', 'access-list 1 permit ip any any'],
  ])('refuses %s with a caret', (_what, line) => {
    const { output, config } = configured([line]);
    expect(output.at(-1)).toBe("% Invalid input detected at '^' marker.");
    expect(config.accessLists).toBeUndefined();
  });

  it('asks for the rest of an unfinished entry', () => {
    expect(configured(['access-list 101 permit tcp any']).output).toEqual([
      '% Incomplete command.',
    ]);
  });

  it('removes a whole list with no access-list, and the field once the last one goes', () => {
    const { config } = configured([
      'access-list 1 permit any',
      'access-list 2 permit any',
      'no access-list 1',
    ]);
    expect(Object.keys(config.accessLists ?? {})).toEqual(['2']);
    expect(configured(['access-list 1 permit any', 'no access-list 1']).config.accessLists).toBe(
      undefined,
    );
  });
});

describe('ip access-list', () => {
  it('opens a named list whose entry lines go to it', () => {
    const { c, config } = configured([
      'ip access-list extended WEB',
      'remark no web from Sales',
      'deny tcp any any eq 80',
      'permit ip any any',
      'exit',
      'ip access-list standard MGMT',
      'permit host 10.0.0.1',
    ]);

    expect(c.prompt).toBe('Router(config-std-nacl)#');
    expect(config.accessLists?.WEB?.entries).toHaveLength(3);
    expect(config.accessLists?.MGMT).toEqual({
      type: 'standard',
      entries: [{ kind: 'rule', action: 'permit', source: host('10.0.0.1') }],
    });
    c.run('exit');
    expect(c.prompt).toBe('Router(config)#');
  });

  it('shows the extended prompt, and refuses a name a list of the other type has', () => {
    const { c, output } = configured([
      'ip access-list extended WEB',
      'exit',
      'ip access-list standard WEB',
    ]);
    expect(output.at(-1)).toBe('% A named extended IP access list with this name already exists');
    c.run('ip access-list extended WEB');
    expect(c.prompt).toBe('Router(config-ext-nacl)#');
  });

  it('removes a named list with no ip access-list', () => {
    const { config } = configured([
      'ip access-list standard MGMT',
      'permit any',
      'exit',
      'no ip access-list standard MGMT',
    ]);
    expect(config.accessLists).toBeUndefined();
  });
});

describe('ip access-group', () => {
  it('applies lists in and out of an interface, and no removes them', () => {
    const { c, config } = configured([
      'interface g0/0',
      'ip access-group 101 in',
      'ip access-group WEB out',
    ]);
    expect(config.interfaces['GigabitEthernet0/0' as never]).toMatchObject({
      accessGroupIn: '101',
      accessGroupOut: 'WEB',
    });

    c.run('no ip access-group 101 in');
    c.run('no ip access-group WEB');
    const after = (c.device.config as RouterConfig).interfaces['GigabitEthernet0/0' as never];
    expect(after).not.toHaveProperty('accessGroupIn');
    expect(after).not.toHaveProperty('accessGroupOut');
  });

  it('works on a subinterface and on a switch VLAN interface, not on a switchport', () => {
    const { config } = configured([
      'interface g0/0.10',
      'encapsulation dot1Q 10',
      'ip access-group 5 in',
    ]);
    expect(config.subinterfaces['GigabitEthernet0/0.10' as never]).toMatchObject({
      accessGroupIn: '5',
    });

    const c = consoleOn(switchDevice());
    c.runAll([...ENTER, 'interface vlan 1', 'ip access-group 5 in', 'interface f0/1']);
    expect(c.run('ip access-group 5 in')).toEqual(["% Invalid input detected at '^' marker."]);
    expect(c.device.config.virtualInterfaces).toMatchObject({ Vlan1: { accessGroupIn: '5' } });
  });
});

describe('running-config', () => {
  const lines = [
    'ip access-list extended WEB',
    ' remark no web',
    ' deny tcp 192.168.1.0 0.0.0.255 any eq www',
    ' permit ip any any',
    'ip access-list standard MGMT',
    ' permit 10.0.0.1',
    'access-list 1 permit 192.168.10.0 0.0.0.255',
    'access-list 1 deny any',
    'access-list 101 remark block HTTP',
    'access-list 101 deny tcp 10.1.0.0 0.0.0.255 10.2.0.0 0.0.0.255 eq www',
    'access-list 101 permit udp any range bootps bootpc host 10.2.0.1 eq 67',
    'access-list 101 permit icmp any host 10.2.0.1 echo',
    'access-list 101 permit ip any any',
  ];

  it('writes interface access groups, named blocks, then numbered lines, and replays to the same config', () => {
    const { c } = configured([
      ...lines,
      'interface g0/0',
      'ip access-group 101 in',
      'ip access-group WEB out',
    ]);
    const running = runningConfig(c.device);

    const at = running.indexOf('interface GigabitEthernet0/0');
    expect(running.slice(at, at + 5)).toEqual([
      'interface GigabitEthernet0/0',
      ' no ip address',
      ' ip access-group 101 in',
      ' ip access-group WEB out',
      ' shutdown',
    ]);
    const first = running.indexOf('ip access-list extended WEB');
    expect(running.slice(first, first + 17)).toEqual([
      'ip access-list extended WEB',
      ' remark no web',
      ' deny tcp 192.168.1.0 0.0.0.255 any eq www',
      ' permit ip any any',
      '!',
      'ip access-list standard MGMT',
      ' permit 10.0.0.1',
      '!',
      'access-list 1 permit 192.168.10.0 0.0.0.255',
      'access-list 1 deny any',
      'access-list 101 remark block HTTP',
      'access-list 101 deny tcp 10.1.0.0 0.0.0.255 10.2.0.0 0.0.0.255 eq www',
      'access-list 101 permit udp any range bootps bootpc host 10.2.0.1 eq bootps',
      'access-list 101 permit icmp any host 10.2.0.1 echo',
      'access-list 101 permit ip any any',
      '!',
      'line con 0',
    ]);

    const replayed = applyLines(withBlankConfig(c.device), running);
    expect(replayed.errors).toEqual([]);
    expect(replayed.config).toEqual(c.device.config);
    expect(runningConfig({ ...c.device, config: replayed.config })).toEqual(running);
  });

  it('round-trips a multilayer switch with an access list on a routed port', () => {
    const c = consoleOn(multilayerSwitch());
    c.runAll([
      ...ENTER,
      'ip routing',
      'access-list 101 deny tcp any any eq www',
      'access-list 101 permit ip any any',
      'interface g0/1',
      'no switchport',
      'ip address 10.0.0.1 255.255.255.0',
      'ip access-group 101 out',
    ]);
    expect(c.device.config.interfaces['GigabitEthernet0/1' as never]).toMatchObject({
      accessGroupOut: '101',
    });
    const running = runningConfig(c.device);
    expect(running).toContain(' ip access-group 101 out');
    const replayed = applyLines(withBlankConfig(c.device), running);
    expect(replayed.errors).toEqual([]);
    expect(replayed.config).toEqual(c.device.config);
  });

  it('round-trips a switch with an access list on its VLAN interface', () => {
    const c = consoleOn(switchDevice());
    c.runAll([
      ...ENTER,
      'access-list 5 permit host 10.0.0.1',
      'interface vlan 1',
      'ip access-group 5 in',
    ]);
    const replayed = applyLines(withBlankConfig(c.device), runningConfig(c.device));
    expect(replayed.errors).toEqual([]);
    expect(replayed.config).toEqual(c.device.config);
  });
});

describe('show access-lists', () => {
  const { c } = configured([
    'access-list 1 permit 192.168.10.0 0.0.0.255',
    'access-list 1 deny host 192.168.10.5',
    'access-list 1 permit any',
    'access-list 101 remark block HTTP',
    'access-list 101 deny tcp any any eq www',
    'access-list 101 permit ip any any',
  ]);

  it('numbers the rules by tens, leaves remarks out, and counts matches', () => {
    const hits: AclHits = { '1': [8], '101': [0, 1, 4] };
    expect(showAccessLists(hits, c.device)).toEqual([
      'Standard IP access list 1',
      '    10 permit 192.168.10.0, wildcard bits 0.0.0.255 (8 matches)',
      '    20 deny 192.168.10.5',
      '    30 permit any',
      'Extended IP access list 101',
      '    10 deny tcp any any eq www (1 match)',
      '    20 permit ip any any (4 matches)',
    ]);
    expect(showAccessLists(hits, c.device, '101')[0]).toBe('Extended IP access list 101');
  });

  it('asks the simulation for hit counts, and shows the lists alone without one', () => {
    c.run('end');
    const { output, query } = c.session.run(c.device, 'show ip access-lists 1');
    expect(query?.kind).toBe('aclHits');
    expect(output).toEqual([
      'Standard IP access list 1',
      '    10 permit 192.168.10.0, wildcard bits 0.0.0.255',
      '    20 deny 192.168.10.5',
      '    30 permit any',
    ]);
  });
});

describe('help', () => {
  it('lists list numbers, actions and what a rule starts with', () => {
    const { c } = configured([]);
    expect(c.session.help(c.device, 'access-list ')).toEqual([
      '  <1-99>     IP standard access list',
      '  <100-199>  IP extended access list',
    ]);
    expect(c.session.help(c.device, 'access-list 101 ')).toEqual([
      '  deny    Specify packets to reject',
      '  permit  Specify packets to forward',
      '  remark  Access list entry comment',
    ]);
    expect(c.session.help(c.device, 'access-list 101 permit ')).toEqual([
      '  icmp  Internet Control Message Protocol',
      '  ip    Any Internet Protocol',
      '  tcp   Transmission Control Protocol',
      '  udp   User Datagram Protocol',
    ]);
    expect(c.session.help(c.device, 'access-list 1 deny ')).toEqual([
      '  A.B.C.D  Address to match',
      '  any      Any source host',
      '  host     A single host address',
    ]);
  });
});
