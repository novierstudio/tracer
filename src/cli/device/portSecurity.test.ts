import { describe, expect, it } from 'vitest';
import type { Layer2Status } from '../../engine/api';
import type { MacAddress, PortId, VlanId } from '../../model';
import type { EngineAnswers } from './query';
import { applyLines, withBlankConfig } from './session';
import { runningConfig } from './show';
import { consoleOn, switchDevice } from './testing';

const ENTER = ['enable', 'configure terminal'];
const FA1 = 'FastEthernet0/1' as PortId;
const PC_MAC = '00:01:63:45:a2:b1' as MacAddress;
const VLAN1 = 1 as VlanId;

const status = (portSecurity: Layer2Status['portSecurity']): Layer2Status =>
  ({
    cdp: { enabled: true, timer: 60, holdtime: 180, interfaces: [], neighbors: [] },
    lldp: { enabled: false, timer: 30, holdtime: 120, neighbors: [] },
    etherchannels: [],
    portSecurity,
    errDisabled: [],
    ports: {},
    clock: 0,
  }) as unknown as Layer2Status;

function live(c: ReturnType<typeof consoleOn>, line: string, answer: Layer2Status) {
  const { query } = c.session.run(c.device, line);
  if (query?.kind !== 'layer2') throw new Error(`${line} asked for ${query?.kind}`);
  return (query.render as (a: EngineAnswers['layer2']) => readonly string[])(answer);
}

const SECURE_FA1: Layer2Status['portSecurity'][number] = {
  port: FA1,
  state: 'secure-up',
  maximum: 2,
  violation: 'restrict',
  violations: 3,
  lastSource: { mac: PC_MAC, vlan: VLAN1 },
  addresses: [{ port: FA1, vlan: VLAN1, mac: PC_MAC, type: 'sticky' }],
};

describe('switchport port-security', () => {
  it('refuses a dynamic port, one per port, as IOS does', () => {
    const c = consoleOn(switchDevice());
    c.runAll([...ENTER, 'interface range fa0/1 - 2']);
    expect(c.run('switchport port-security')).toEqual([
      'Command rejected: FastEthernet0/1 is a dynamic port.',
      'Command rejected: FastEthernet0/2 is a dynamic port.',
    ]);
    expect(c.device.config.interfaces[FA1]!.portSecurity).toBeUndefined();
  });

  it('takes an access port, and writes its lines in Packet Tracer’s order', () => {
    const c = consoleOn(switchDevice());
    const lines = c.runAll([
      ...ENTER,
      'interface fa0/1',
      'switchport mode access',
      'switchport port-security',
      'switchport port-security maximum 2',
      'switchport port-security mac-address sticky',
      'switchport port-security violation restrict',
      'switchport port-security mac-address sticky 0001.6345.a2b1',
      'switchport port-security mac-address 0001.6345.0002',
    ]);
    expect(lines).toEqual(['Enter configuration commands, one per line.  End with CNTL/Z.']);
    const config = runningConfig(c.device);
    const at = config.indexOf('interface FastEthernet0/1');
    expect(config.slice(at, at + 9)).toEqual([
      'interface FastEthernet0/1',
      ' switchport mode access',
      ' switchport port-security',
      ' switchport port-security maximum 2',
      ' switchport port-security mac-address sticky',
      ' switchport port-security violation restrict',
      ' switchport port-security mac-address sticky 0001.6345.A2B1',
      ' switchport port-security mac-address 0001.6345.0002',
      '!',
    ]);
    const again = applyLines(withBlankConfig(c.device), config);
    expect(again.errors).toEqual([]);
    expect(runningConfig({ ...c.device, config: again.config })).toEqual(config);
  });

  it('a trunk takes port security without a word, as Packet Tracer does', () => {
    const c = consoleOn(switchDevice());
    c.runAll([...ENTER, 'interface gi0/1', 'switchport mode trunk']);
    expect(c.run('switchport port-security')).toEqual([]);
  });

  it('no mac-address sticky drops the sticky addresses', () => {
    const c = consoleOn(switchDevice());
    c.runAll([
      ...ENTER,
      'interface fa0/1',
      'switchport mode access',
      'switchport port-security mac-address sticky',
      'switchport port-security mac-address sticky 0001.6345.a2b1',
      'no switchport port-security mac-address sticky',
    ]);
    expect(c.device.config.interfaces[FA1]!.portSecurity).toEqual({
      enabled: false,
      addresses: [],
    });
  });

  it('helps as Packet Tracer does', () => {
    const c = consoleOn(switchDevice());
    c.runAll([...ENTER, 'interface fa0/1']);
    expect(c.session.help(c.device, 'switchport port-security violation ')).toEqual([
      '  protect   Security violation protect mode',
      '  restrict  Security violation restrict mode',
      '  shutdown  Security violation shutdown mode',
    ]);
    expect(c.session.help(c.device, 'switchport port-security mac-address ')).toEqual([
      '  H.H.H   48 bit mac address',
      '  sticky  Configure dynamic secure addresses as sticky',
    ]);
    expect(c.session.help(c.device, 'switchport port-security maximum ')).toEqual([
      '  <1-132>  Maximum addresses',
    ]);
  });

  it('errdisable recovery lands in the running-config', () => {
    const c = consoleOn(switchDevice());
    c.runAll([
      ...ENTER,
      'errdisable recovery cause psecure-violation',
      'errdisable recovery interval 30',
    ]);
    const config = runningConfig(c.device);
    expect(config).toContain('errdisable recovery cause psecure-violation');
    expect(config).toContain('errdisable recovery interval 30');
  });
});

describe('show port-security', () => {
  it('lists each secure port in Packet Tracer’s columns', () => {
    const c = consoleOn(switchDevice());
    c.run('enable');
    expect(live(c, 'show port-security', status([SECURE_FA1]))).toEqual([
      'Secure Port MaxSecureAddr CurrentAddr SecurityViolation Security Action',
      '               (Count)       (Count)        (Count)',
      '--------------------------------------------------------------------',
      '        Fa0/1        2          1                 3         Restrict',
      '----------------------------------------------------------------------',
    ]);
  });

  it('address lists the secure address table', () => {
    const c = consoleOn(switchDevice());
    c.run('enable');
    expect(live(c, 'show port-security address', status([SECURE_FA1]))).toEqual([
      '               Secure Mac Address Table',
      '-----------------------------------------------------------------------------',
      'Vlan    Mac Address       Type                          Ports   Remaining Age',
      '                                                                   (mins)',
      '----    -----------       ----                          -----   -------------',
      '   1    0001.6345.A2B1    SecureSticky                  Fa0/1        -',
      '-----------------------------------------------------------------------------',
      'Total Addresses in System (excluding one mac per port)     : 0',
      'Max Addresses limit in System (excluding one mac per port) : 1024',
    ]);
  });

  it('interface shows one port, err-disabled or not', () => {
    const c = consoleOn(switchDevice());
    c.runAll([
      ...ENTER,
      'interface fa0/1',
      'switchport mode access',
      'switchport port-security',
      'switchport port-security maximum 2',
      'switchport port-security violation restrict',
      'end',
    ]);
    const shutdown = { ...SECURE_FA1, state: 'secure-shutdown' as const };
    expect(live(c, 'show port-security interface fa0/1', status([shutdown]))).toEqual([
      'Port Security              : Enabled',
      'Port Status                : Secure-shutdown',
      'Violation Mode             : Restrict',
      'Aging Time                 : 0 mins',
      'Aging Type                 : Absolute',
      'SecureStatic Address Aging : Disabled',
      'Maximum MAC Addresses      : 2',
      'Total MAC Addresses        : 1',
      'Configured MAC Addresses   : 0',
      'Sticky MAC Addresses       : 1',
      'Last Source Address:Vlan   : 0001.6345.A2B1:1',
      'Security Violation Count   : 3',
    ]);
    expect(live(c, 'show port-security interface fa0/2', status([]))).toContain(
      'Last Source Address:Vlan   : 0000.0000.0000:0',
    );
  });
});
