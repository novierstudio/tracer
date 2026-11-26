import { describe, expect, it } from 'vitest';
import { applyLines, openConsole, openVty, withBlankConfig, type DeviceSession } from './session';
import type { IosDevice, SessionLine } from './context';
import { runningConfig } from './show';
import type { VtySession } from './query';
import { showUsers } from './remote';
import { consoleOn, router, switchDevice } from './testing';

const PEER = '10.0.0.10' as never;

/** A device configured by typing `lines` in global config mode. */
function configured<D extends IosDevice>(device: D, lines: readonly string[]): D {
  const { config, errors } = applyLines(device, lines);
  if (errors.length > 0 || config.unknownLines.length > 0) {
    throw new Error(JSON.stringify({ errors, unknown: config.unknownLines }));
  }
  return { ...device, config };
}

type Vty = Extract<SessionLine, { kind: 'vty' }>;
const telnet: Vty = { kind: 'vty', index: 0, protocol: 'telnet', peer: PEER };
const ssh = (user: string): Vty => ({ ...telnet, protocol: 'ssh', user });

function refusal(device: IosDevice, line: Vty) {
  const opened = openVty(device, line);
  return 'refused' in opened ? opened.refused : undefined;
}

/** Opens a vty session and types `lines`, collecting what each prints and the prompts. */
function remote(device: IosDevice, line: Vty, lines: readonly string[] = []) {
  const opened = openVty(device, line);
  if ('refused' in opened) throw new Error(`Refused: ${opened.refused.join(' ')}`);
  const { session, greeting } = opened;
  const transcript: string[] = [...greeting];
  let disconnected = false;
  for (const text of lines) {
    transcript.push(`${session.prompt(device)}${session.readingPassword ? '' : text}`);
    const result = session.run(device, text);
    transcript.push(...result.output);
    if (result.disconnect) disconnected = true;
  }
  return { session, transcript, disconnected, prompt: session.prompt(device) };
}

const VTY_PASSWORD = ['line vty 0 4', ' password cisco', ' login'];
const VTY_LOCAL = ['username admin secret class', 'line vty 0 15', ' login local'];

describe('username', () => {
  it('keeps a secret as an MD5 hash and replays from the running-config', () => {
    const device = configured(router(), ['username admin privilege 15 secret class']);
    const line = runningConfig(device).find((text) => text.startsWith('username'));
    expect(line).toMatch(/^username admin privilege 15 secret 5 \$1\$[./0-9A-Za-z]+\$/);
    const replayed = configured(withBlankConfig(device), runningConfig(device).slice(1, -1));
    expect(replayed.config.users).toEqual(device.config.users);
  });

  it('shows a password in clear text, or as type 7 with service password-encryption', () => {
    const plain = configured(router(), ['username bob password cisco']);
    expect(runningConfig(plain)).toContain('username bob password 0 cisco');
    const hidden = configured(plain, ['service password-encryption']);
    const line = runningConfig(hidden).find((text) => text.startsWith('username'))!;
    expect(line).toMatch(/^username bob password 7 [0-9A-F]+$/);
    const replayed = configured(withBlankConfig(hidden), runningConfig(hidden).slice(1, -1));
    expect(replayed.config.users).toEqual(plain.config.users);
  });

  it('refuses a password for a user with a secret, and `no username` removes the user', () => {
    const c = consoleOn(router());
    c.runAll(['enable', 'configure terminal', 'username admin secret class']);
    expect(c.run('username admin password cisco')).toEqual([
      'ERROR: Can not have both a user password and a user secret.',
    ]);
    c.run('no username admin');
    expect(c.device.config.users).toBeUndefined();
  });
});

describe('crypto key generate rsa', () => {
  const ready = () => {
    const c = consoleOn(router(undefined, 'R1'));
    c.runAll(['enable', 'configure terminal']);
    return c;
  };

  it('needs a hostname of its own, then a domain name', () => {
    const c = consoleOn(router());
    c.runAll(['enable', 'configure terminal']);
    expect(c.run('crypto key generate rsa')).toEqual([
      '% Please define a hostname other than Router.',
    ]);
    c.run('hostname R1');
    expect(c.run('crypto key generate rsa')).toEqual(['% Please define a domain-name first.']);
    expect(c.device.config.rsaModulus).toBeUndefined();
  });

  it('asks for the modulus, takes 512 for a blank answer, and turns SSH on', () => {
    const c = ready();
    c.run('ip domain-name example.com');
    expect(c.run('crypto key generate rsa')).toEqual([
      'The name for the keys will be: R1.example.com',
      'Choose the size of the key modulus in the range of 360 to 2048 for your',
      '  General Purpose Keys. Choosing a key modulus greater than 512 may take',
      '  a few minutes.',
      '',
    ]);
    expect(c.prompt).toBe('How many bits in the modulus [512]: ');
    expect(c.run('')).toEqual([
      '% Generating 512 bit RSA keys, keys will be non-exportable...[OK]',
      '',
      '%SSH-5-ENABLED: SSH 1.99 has been enabled',
    ]);
    expect(c.device.config.rsaModulus).toBe(512);
    expect(c.prompt).toBe('R1(config)#');
  });

  it('takes the modulus on the command line, and asks before replacing keys', () => {
    const c = ready();
    c.run('ip domain-name example.com');
    expect(c.run('crypto key generate rsa general-keys modulus 1024')).toEqual([
      'The name for the keys will be: R1.example.com',
      '% The key modulus size is 1024 bits',
      '% Generating 1024 bit RSA keys, keys will be non-exportable...[OK]',
      '',
      '%SSH-5-ENABLED: SSH 1.99 has been enabled',
    ]);
    expect(c.run('crypto key generate rsa modulus 2048')).toEqual([
      '% You already have RSA keys defined named R1.example.com .',
    ]);
    expect(c.prompt).toBe('% Do you really want to replace them? [yes/no]: ');
    c.run('no');
    expect(c.device.config.rsaModulus).toBe(1024);
    c.run('crypto key generate rsa modulus 2048');
    c.run('yes');
    expect(c.device.config.rsaModulus).toBe(2048);
  });

  it('refuses SSH version 2 on keys under 768 bits', () => {
    const c = ready();
    c.runAll(['ip domain-name example.com', 'crypto key generate rsa modulus 512']);
    expect(c.run('ip ssh version 2')).toEqual([
      'Please create RSA keys (of atleast 768 bits size) to enable SSH v2.',
    ]);
    c.runAll(['crypto key generate rsa modulus 1024', 'yes', 'ip ssh version 2', 'end']);
    expect(c.run('show ip ssh')).toEqual([
      'SSH Enabled - version 2.0',
      'Authentication timeout: 120 secs; Authentication retries: 3',
    ]);
    expect(runningConfig(c.device)).toEqual(
      expect.arrayContaining(['ip ssh version 2', 'ip domain-name example.com']),
    );
  });

  it('says SSH is off until there are keys', () => {
    const c = consoleOn(router());
    expect(c.run('show ip ssh')).toEqual([
      'SSH Disabled - version 1.99',
      '%Please create RSA keys to enable SSH (and of atleast 768 bits for SSH v2).',
      'Authentication timeout: 120 secs; Authentication retries: 3',
    ]);
  });
});

describe('vty login', () => {
  it('asks for the line password with `login`, and hangs up after three wrong ones', () => {
    const device = configured(router(undefined, 'R2'), VTY_PASSWORD);
    const good = remote(device, telnet, ['cisco']);
    expect(good.transcript).toEqual(['', 'User Access Verification', '', 'Password: ']);
    expect(good.prompt).toBe('R2>');

    const bad = remote(device, telnet, ['a', 'b', 'c']);
    expect(bad.transcript.slice(-1)).toEqual(['% Bad passwords']);
    expect(bad.disconnected).toBe(true);
  });

  it('refuses a line with `login` and no password', () => {
    expect(refusal(router(), telnet)).toEqual(['', 'Password required, but none set']);
  });

  it('lets anyone in with `no login`', () => {
    const device = configured(router(undefined, 'R2'), ['line vty 0 4', ' no login']);
    expect(remote(device, telnet).prompt).toBe('R2>');
  });

  it('asks Telnet for a username and password with `login local`', () => {
    const device = configured(router(undefined, 'R2'), VTY_LOCAL);
    const wrong = remote(device, telnet, ['admin', 'nope']);
    expect(wrong.transcript.slice(-2)).toEqual(['% Login invalid', '']);
    expect(wrong.prompt).toBe('Username: ');

    const right = remote(device, telnet, ['admin', 'class']);
    expect(right.transcript).toEqual([
      '',
      'User Access Verification',
      '',
      'Username: admin',
      'Password: ',
    ]);
    expect(right.prompt).toBe('R2>');
  });

  it('asks SSH only for the password of the user it named, and starts at privilege 15', () => {
    const device = configured(router(undefined, 'R2'), [
      'username boss privilege 15 secret top',
      ...VTY_LOCAL,
    ]);
    const boss = remote(device, ssh('boss'), ['top']);
    expect(boss.transcript).toEqual(['', 'Password: ']);
    expect(boss.prompt).toBe('R2#');

    const stranger = remote(device, ssh('eve'), ['x', 'y', 'z']);
    expect(stranger.transcript.filter((text) => text === '% Login invalid')).toHaveLength(3);
    expect(stranger.disconnected).toBe(true);
  });

  it('asks the console for a username with `login local`', () => {
    const device = configured(router(undefined, 'R2'), [
      'username admin secret class',
      'line con 0',
      ' login local',
    ]);
    const { session, greeting } = openConsole(device);
    expect(greeting).toEqual(['', 'User Access Verification', '']);
    expect(session.prompt(device)).toBe('Username: ');
    session.run(device, 'admin');
    expect(session.readingPassword).toBe(true);
    session.run(device, 'class');
    expect(session.prompt(device)).toBe('R2>');
  });
});

describe('a vty session', () => {
  const loggedIn = (device: IosDevice): DeviceSession => {
    return remote(device, telnet, ['cisco']).session;
  };

  it('needs an enable password to reach privileged EXEC, unlike the console', () => {
    const bare = configured(router(undefined, 'R2'), VTY_PASSWORD);
    const session = loggedIn(bare);
    expect(session.run(bare, 'enable').output).toEqual(['% No password set']);
    expect(session.prompt(bare)).toBe('R2>');

    const secured = configured(bare, ['enable secret class']);
    const again = loggedIn(secured);
    again.run(secured, 'enable');
    again.run(secured, 'class');
    expect(again.prompt(secured)).toBe('R2#');
  });

  it('ends with `exit` or `logout`, which on the console only leave privileged EXEC', () => {
    const device = configured(router(undefined, 'R2'), VTY_PASSWORD);
    expect(loggedIn(device).run(device, 'exit').disconnect).toBe(true);
    expect(loggedIn(device).run(device, 'logout').disconnect).toBe(true);
    const { session } = openConsole(device);
    expect(session.run(device, 'exit').disconnect).toBeUndefined();
  });

  it('asks the terminal to open Telnet and SSH sessions onward', () => {
    const device = configured(router(undefined, 'R2'), VTY_PASSWORD);
    const session = loggedIn(device);
    expect(session.run(device, 'telnet 10.0.0.2').connect).toEqual({
      protocol: 'telnet',
      target: '10.0.0.2',
    });
    expect(session.run(device, 'ssh -l admin 10.0.0.3').connect).toEqual({
      protocol: 'ssh',
      target: '10.0.0.3',
      user: 'admin',
    });
    expect(session.run(device, 'ssh -v 2 -l admin 10.0.0.3').connect).toMatchObject({
      user: 'admin',
    });
  });
});

describe('show users and show ssh', () => {
  it('marks the console as this session, with no simulation to ask', () => {
    const c = consoleOn(router());
    expect(c.run('show users')).toEqual([
      '    Line       User       Host(s)              Idle       Location',
      '*  0 con 0                idle                 00:00:00',
      '',
      '  Interface    User               Mode         Idle     Peer Address',
      '',
    ]);
  });

  it('lists vty sessions by absolute line, marking the one asking', () => {
    const sessions = [
      { line: 0, protocol: 'ssh', peer: '10.0.0.10', user: 'admin' },
      { line: 1, protocol: 'telnet', peer: '10.0.0.11' },
    ] as VtySession[];
    const own = { ...telnet, index: 1, peer: '10.0.0.11' } as Vty;
    expect(showUsers(switchDevice(), own, sessions).slice(1, 3)).toEqual([
      '   1 vty 0     admin      idle                 00:00:00 10.0.0.10',
      '*  2 vty 1                idle                 00:00:00 10.0.0.11',
    ]);
    expect(showUsers(router(), own, sessions)[1]).toMatch(/^ {3}2 vty 0/);
  });

  it('shows SSH connections in and out, or none', () => {
    const c = consoleOn(router());
    expect(c.run('show ssh')).toEqual([
      '%No SSHv2 server connections running.',
      '%No SSHv1 server connections running.',
    ]);
    const device = configured(router(undefined, 'R2'), [
      'username admin secret class',
      'line vty 0 4',
      ' login local',
    ]);
    const opened = remote(device, ssh('admin'), ['class', 'show ssh']);
    expect(opened.transcript.slice(-4)).toEqual([
      'Connection Version Mode Encryption  Hmac         State                 Username',
      '0          2.0     IN   aes256-cbc  hmac-sha1    Session started       admin',
      '0          2.0     OUT  aes256-cbc  hmac-sha1    Session started       admin',
      '%No SSHv1 server connections running.',
    ]);
  });
});
