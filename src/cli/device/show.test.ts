import { describe, expect, it } from 'vitest';
import { hashSecret } from '../passwords';
import { consoleOn, router, switchDevice } from './testing';

const ENTER = ['enable', 'configure terminal'];

function configuredRouter() {
  const c = consoleOn(router(['GigabitEthernet0/0', 'GigabitEthernet0/1', 'Serial0/0/0']));
  c.runAll([
    ...ENTER,
    'hostname R1',
    'enable secret class',
    'service password-encryption',
    'no ip domain-lookup',
    'banner motd #Authorized access only#',
    'interface g0/0',
    'description LAN',
    'ip address 192.168.1.1 255.255.255.0',
    'no shutdown',
    'interface s0/0/0',
    'ip address 10.0.0.1 255.255.255.252',
    'clock rate 64000',
    'no shutdown',
    'exit',
    'ip route 0.0.0.0 0.0.0.0 10.0.0.2',
    'line con 0',
    'password cisco',
    'login',
    'line vty 0 4',
    'password cisco',
    'login',
    'transport input ssh',
    'end',
  ]);
  return c;
}

function configuredSwitch() {
  const c = consoleOn(switchDevice(['FastEthernet0/1', 'FastEthernet0/2', 'GigabitEthernet0/1']));
  c.runAll([
    ...ENTER,
    'hostname S1',
    'interface vlan 1',
    'ip address 192.168.1.2 255.255.255.0',
    'no shutdown',
    'exit',
    'ip default-gateway 192.168.1.1',
    'interface f0/1',
    'switchport access vlan 10',
    'interface f0/2',
    'shutdown',
    'interface g0/1',
    'switchport mode trunk',
    'end',
  ]);
  return c;
}

describe('show running-config', () => {
  it('prints a configured router in IOS order', () => {
    const c = configuredRouter();

    expect(c.run('show running-config')).toEqual([
      'Building configuration...',
      '',
      'Current configuration : 577 bytes',
      '!',
      'version 15.1',
      'service password-encryption',
      '!',
      'hostname R1',
      '!',
      `enable secret 5 ${hashSecret('class')}`,
      'no ip domain-lookup',
      '!',
      'interface GigabitEthernet0/0',
      ' description LAN',
      ' ip address 192.168.1.1 255.255.255.0',
      '!',
      'interface GigabitEthernet0/1',
      ' no ip address',
      ' shutdown',
      '!',
      'interface Serial0/0/0',
      ' ip address 10.0.0.1 255.255.255.252',
      ' clock rate 64000',
      '!',
      'ip route 0.0.0.0 0.0.0.0 10.0.0.2',
      '!',
      'banner motd ^CAuthorized access only^C',
      '!',
      'line con 0',
      ' password 7 01100F175804',
      ' login',
      '!',
      'line aux 0',
      '!',
      'line vty 0 4',
      ' password 7 01100F175804',
      ' login',
      ' transport input ssh',
      'line vty 5 15',
      ' login',
      '!',
      'end',
    ]);
  });

  it('prints a configured switch in IOS order', () => {
    const c = configuredSwitch();

    expect(c.run('show running-config').slice(3)).toEqual([
      '!',
      'version 15.1',
      'no service password-encryption',
      '!',
      'hostname S1',
      '!',
      '!',
      'interface FastEthernet0/1',
      ' switchport access vlan 10',
      '!',
      'interface FastEthernet0/2',
      ' shutdown',
      '!',
      'interface GigabitEthernet0/1',
      ' switchport mode trunk',
      '!',
      'interface Vlan1',
      ' ip address 192.168.1.2 255.255.255.0',
      '!',
      'ip default-gateway 192.168.1.1',
      '!',
      'line con 0',
      '!',
      'line vty 0 4',
      ' login',
      'line vty 5 15',
      ' login',
      '!',
      'end',
    ]);
  });

  it('is privileged', () => {
    const c = consoleOn(router());

    expect(c.run('show running-config')).toContain("% Invalid input detected at '^' marker.");
  });
});

describe('show startup-config', () => {
  it('has nothing until the first save, then the saved config', () => {
    const c = configuredRouter();

    expect(c.run('show startup-config')).toEqual(['startup-config is not present']);
    c.run('copy running-config startup-config');
    c.runAll(['conf t', 'hostname Changed', 'end']);
    const saved = c.run('show startup-config');

    expect(saved[0]).toMatch(/^Using \d+ bytes$/);
    expect(saved).toContain('hostname R1');
    expect(saved).not.toContain('hostname Changed');
  });
});

describe('show ip interface brief', () => {
  it('lists every interface with its address and its status from the config', () => {
    expect(configuredRouter().run('show ip interface brief')).toEqual([
      'Interface              IP-Address      OK? Method Status                Protocol',
      'GigabitEthernet0/0     192.168.1.1     YES manual up                    up',
      'GigabitEthernet0/1     unassigned      YES unset  administratively down down',
      'Serial0/0/0            10.0.0.1        YES manual up                    up',
    ]);
    expect(configuredSwitch().run('sh ip int br')).toEqual([
      'Interface              IP-Address      OK? Method Status                Protocol',
      'FastEthernet0/1        unassigned      YES unset  up                    up',
      'FastEthernet0/2        unassigned      YES unset  administratively down down',
      'GigabitEthernet0/1     unassigned      YES unset  up                    up',
      'Vlan1                  192.168.1.2     YES manual up                    up',
    ]);
  });
});

describe('show interfaces', () => {
  it('describes one interface', () => {
    const c = configuredRouter();
    const port = c.device.ports.find((p) => p.id === 'GigabitEthernet0/0');
    const mac = port && 'mac' in port ? port.mac.replace(/:/g, '').match(/.{4}/g)!.join('.') : '';

    expect(c.run('show interfaces g0/0')).toEqual([
      'GigabitEthernet0/0 is up, line protocol is up',
      `  Hardware is CN Gigabit Ethernet, address is ${mac} (bia ${mac})`,
      '  Description: LAN',
      '  Internet address is 192.168.1.1/24',
      '  MTU 1500 bytes, BW 1000000 Kbit, DLY 10 usec,',
      '  Encapsulation ARPA, loopback not set',
    ]);
    expect(c.run('show interfaces s0/0/0')).toEqual([
      'Serial0/0/0 is up, line protocol is up',
      '  Hardware is HD64570',
      '  Internet address is 10.0.0.1/30',
      '  MTU 1500 bytes, BW 1544 Kbit, DLY 20000 usec,',
      '  Encapsulation HDLC, loopback not set',
    ]);
  });

  it('describes every interface, and refuses one the device lacks', () => {
    const c = configuredRouter();

    expect(c.run('show interfaces').filter((line) => !line.startsWith(' '))).toEqual([
      'GigabitEthernet0/0 is up, line protocol is up',
      'GigabitEthernet0/1 is administratively down, line protocol is down',
      'Serial0/0/0 is up, line protocol is up',
    ]);
    expect(c.run('show interfaces lo5')).toEqual(["% Invalid input detected at '^' marker."]);
  });
});

describe('show version', () => {
  it('names the hostname and counts the ports', () => {
    const output = configuredRouter().run('show version');

    expect(output).toContain('R1 uptime is 0 minutes');
    expect(output).toContain('2 Gigabit Ethernet interfaces');
    expect(output).toContain('1 Serial interface');
  });
});
