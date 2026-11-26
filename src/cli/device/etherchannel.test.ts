import { describe, expect, it } from 'vitest';
import type { Layer2Status } from '../../engine/api';
import type { PortId } from '../../model';
import type { EngineAnswers } from './query';
import { applyLines, withBlankConfig } from './session';
import { runningConfig } from './show';
import { consoleOn, switchDevice } from './testing';

const ENTER = ['enable', 'configure terminal'];

const fa = (n: number) => `FastEthernet0/${n}` as PortId;

/** Layer 2 status with these EtherChannels and nothing else, at 5 min 30 s into the run. */
const status = (etherchannels: Layer2Status['etherchannels']): Layer2Status =>
  ({
    cdp: { enabled: true, timer: 60, holdtime: 180, interfaces: [], neighbors: [] },
    lldp: { enabled: false, timer: 30, holdtime: 120, neighbors: [] },
    etherchannels,
    portSecurity: [],
    errDisabled: [],
    ports: {},
    clock: 330_000,
  }) as unknown as Layer2Status;

function live(c: ReturnType<typeof consoleOn>, line: string, answer: Layer2Status) {
  const { query } = c.session.run(c.device, line);
  if (query?.kind !== 'layer2') throw new Error(`${line} asked for ${query?.kind}`);
  return (query.render as (a: EngineAnswers['layer2']) => readonly string[])(answer);
}

describe('channel-group', () => {
  it('creates the port-channel with the first member, from its switchport', () => {
    const c = consoleOn(switchDevice());
    c.runAll([...ENTER, 'interface range fa0/1 - 2', 'switchport mode trunk']);
    expect(c.run('channel-group 1 mode active')).toEqual([
      'Creating a port-channel interface Port-channel 1',
    ]);
    expect(c.device.config.interfaces[fa(2)]!.channelGroup).toEqual({ group: 1, mode: 'active' });
    expect(c.device.config.portChannels?.['Port-channel1' as never]).toMatchObject({
      switchport: { mode: 'trunk' },
    });
  });

  it('refuses a port that would negotiate with another protocol than its group', () => {
    const c = consoleOn(switchDevice());
    c.runAll([...ENTER, 'interface fa0/1', 'channel-group 1 mode active', 'interface fa0/3']);
    expect(c.run('channel-group 1 mode desirable')).toEqual([
      'Command rejected (Channel protocol mismatch for interface Fa0/3 in group 1): the interface can not be added to the channel group',
    ]);
    expect(c.device.config.interfaces[fa(3)]!.channelGroup).toBeUndefined();
  });

  it('helps with the modes as IOS does', () => {
    const c = consoleOn(switchDevice());
    c.runAll([...ENTER, 'interface fa0/1']);
    expect(c.session.help(c.device, 'channel-group ')).toEqual(['  <1-6>  Channel group number']);
    expect(c.session.help(c.device, 'channel-group 1 mode ')).toEqual([
      '  active     Enable LACP unconditionally',
      '  auto       Enable PAgP only if a PAgP device is detected',
      '  desirable  Enable PAgP unconditionally',
      '  on         Enable Etherchannel only',
      '  passive    Enable LACP only if a LACP device is detected',
    ]);
  });

  it('copies port-channel settings to its members', () => {
    const c = consoleOn(switchDevice());
    c.runAll([
      ...ENTER,
      'interface range fa0/1 - 2',
      'channel-group 2 mode on',
      'interface port-channel 2',
      'switchport mode trunk',
      'switchport trunk native vlan 99',
      'shutdown',
    ]);
    for (const port of [fa(1), fa(2)]) {
      expect(c.device.config.interfaces[port]).toMatchObject({
        shutdown: true,
        switchport: { mode: 'trunk', nativeVlan: 99 },
      });
    }
  });

  it('no interface port-channel takes its members out of the group', () => {
    const c = consoleOn(switchDevice());
    c.runAll([...ENTER, 'interface fa0/1', 'channel-group 1 mode on', 'exit']);
    c.run('no interface port-channel 1');
    expect(c.device.config.portChannels).toBeUndefined();
    expect(c.device.config.interfaces[fa(1)]!.channelGroup).toBeUndefined();
  });

  it('writes port-channels before the ports, and replays to the same config', () => {
    const c = consoleOn(switchDevice());
    c.runAll([
      ...ENTER,
      'port-channel load-balance src-dst-mac',
      'interface range fa0/1 - 2',
      'switchport mode trunk',
      'channel-group 1 mode desirable',
    ]);
    const config = runningConfig(c.device);
    const at = (line: string) => config.indexOf(line);
    expect(config).toContain('port-channel load-balance src-dst-mac');
    expect(config.slice(at('interface Port-channel1'), at('interface Port-channel1') + 3)).toEqual([
      'interface Port-channel1',
      ' switchport mode trunk',
      '!',
    ]);
    expect(at('interface Port-channel1')).toBeLessThan(at('interface FastEthernet0/1'));
    expect(
      config.slice(at('interface FastEthernet0/1'), at('interface FastEthernet0/1') + 4),
    ).toEqual([
      'interface FastEthernet0/1',
      ' switchport mode trunk',
      ' channel-group 1 mode desirable',
      '!',
    ]);
    const again = applyLines(withBlankConfig(c.device), config);
    expect(again.errors).toEqual([]);
    expect(runningConfig({ ...c.device, config: again.config })).toEqual(config);
  });
});

describe('show etherchannel', () => {
  const groups: Layer2Status['etherchannels'] = [
    {
      group: 1,
      protocol: 'lacp',
      inUse: true,
      upSince: 1000 as never,
      members: [
        { port: fa(1), mode: 'active', flag: 'P', bundledAt: 1000 as never },
        { port: fa(2), mode: 'active', flag: 'P', bundledAt: 4000 as never },
      ],
    },
    {
      group: 2,
      protocol: 'pagp',
      inUse: false,
      members: [{ port: fa(3), mode: 'auto', flag: 'I' }],
    },
    { group: 3, protocol: undefined, inUse: false, members: [] },
  ];

  it('summary prints the flags legend and one row per group, as Packet Tracer does', () => {
    const c = consoleOn(switchDevice());
    c.run('enable');
    expect(live(c, 'show etherchannel summary', status(groups))).toEqual([
      'Flags:  D - down        P - in port-channel',
      '        I - stand-alone s - suspended',
      '        H - Hot-standby (LACP only)',
      '        R - Layer3      S - Layer2',
      '        U - in use      f - failed to allocate aggregator',
      '        u - unsuitable for bundling',
      '        w - waiting to be aggregated',
      '        d - default port',
      '',
      '',
      'Number of channel-groups in use: 3',
      'Number of aggregators:           3',
      '',
      'Group  Port-channel  Protocol    Ports',
      '------+-------------+-----------+----------------------------------------------',
      '',
      '1      Po1(SU)           LACP   Fa0/1(P) Fa0/2(P) ',
      '2      Po2(SD)           PAgP   Fa0/3(I) ',
      '3      Po3(SD)           -',
    ]);
  });

  it('port-channel lists each bundle with its ports and ages', () => {
    const c = consoleOn(switchDevice());
    c.run('enable');
    expect(live(c, 'show etherchannel port-channel', status(groups.slice(0, 1)))).toEqual([
      '                Channel-group listing:',
      '                ----------------------',
      '',
      'Group: 1',
      '----------',
      '                Port-channels in the group:',
      '                ---------------------------',
      '',
      'Port-channel: Po1    (Primary Aggregator)',
      '------------',
      '',
      'Age of the Port-channel   = 00d:00h:05m:29s',
      'Logical slot/port   = 2/1       Number of ports = 2 ',
      'GC                  = 0x00000000      HotStandBy port = null',
      'Port state          = Port-channel ',
      'Protocol            =   LACP',
      'Port Security       = Disabled',
      '',
      'Ports in the Port-channel:',
      '',
      'Index   Load   Port     EC state        No of bits',
      '------+------+------+------------------+-----------',
      '  0     00     Fa0/1    Active             0',
      '  0     00     Fa0/2    Active             0',
      'Time since last port bundled:    00d:00h:05m:26s    Fa0/2',
      '',
    ]);
  });

  it('load-balance names the hash `port-channel load-balance` set', () => {
    const c = consoleOn(switchDevice());
    c.runAll([...ENTER, 'port-channel load-balance dst-ip', 'end']);
    expect(c.run('show etherchannel load-balance')).toEqual([
      'EtherChannel Load-Balancing Operational State (dst-ip):',
      '  Non-IP: Destination MAC address',
      '  IPv4: Destination IP address',
      '  IPv6: Destination IP address',
    ]);
  });
});
