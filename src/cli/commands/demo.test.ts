import { describe, expect, it } from 'vitest';
import { formatError } from '../format';
import type { InterfaceName } from '../interfaces';
import { GLOBAL_CONFIG, PRIV_EXEC, prompt, USER_EXEC, type Mode } from '../modes';
import { complete, help, parse } from '../parser';
import { DEFAULT_HOSTNAME, demoTree, type DemoContext, type InterfaceAddress } from './demo';

const g00 = 'GigabitEthernet0/0' as InterfaceName;
const IF: Mode = { kind: 'interface-config', interfaces: [g00] };
const LINE: Mode = { kind: 'line-config', line: 'console 0' };
const ROUTER: Mode = { kind: 'router-config', protocol: 'rip' };

/** A terminal-like driver: echo-free, returns the lines IOS would print. */
function session() {
  let hostname = DEFAULT_HOSTNAME;
  let mode: Mode = USER_EXEC;
  const addresses = new Map<InterfaceName, InterfaceAddress | undefined>();
  const shutdown = new Map<InterfaceName, boolean>();
  const ctx: DemoContext = {
    get hostname() {
      return hostname;
    },
    setHostname: (name) => (hostname = name),
    setAddress: (name, address) => addresses.set(name, address),
    setShutdown: (name, down) => shutdown.set(name, down),
  };
  return {
    addresses,
    shutdown,
    get prompt() {
      return prompt(hostname, mode);
    },
    run(line: string): readonly string[] {
      const result = parse(line, mode, demoTree);
      if (result.kind === 'empty') return [];
      if (result.kind === 'error') return formatError(result.error, this.prompt.length);
      const output = result.execute(ctx);
      mode = result.mode;
      return output;
    },
  };
}

describe('demo commands: abbreviation', () => {
  it.each<[string, Mode, string]>([
    ['en', USER_EXEC, 'enable'],
    ['conf t', PRIV_EXEC, 'configure terminal'],
    ['CONF T', PRIV_EXEC, 'configure terminal'],
    ['sh ver', PRIV_EXEC, 'show version'],
    ['disa', PRIV_EXEC, 'disable'],
    ['host R2', GLOBAL_CONFIG, 'hostname'],
    ['int g0/0', GLOBAL_CONFIG, 'interface'],
    ['int ra f0/1 - 2', GLOBAL_CONFIG, 'interface range'],
    ['ip add 10.0.0.1 255.255.255.0', IF, 'ip address'],
    ['shut', IF, 'shutdown'],
  ])('%j in %o resolves to %s', (input, mode, command) => {
    expect(parse(input, mode, demoTree)).toMatchObject({ kind: 'command', command });
  });

  it('keeps the case of a WORD argument', () => {
    expect(parse('host Core-R1', GLOBAL_CONFIG, demoTree)).toMatchObject({
      args: { name: 'Core-R1' },
    });
  });

  it('types the ip address args', () => {
    expect(parse('ip add 10.0.0.1 255.255.255.0', IF, demoTree)).toMatchObject({
      args: { ip: '10.0.0.1', mask: '255.255.255.0' },
    });
  });
});

describe('demo commands: errors', () => {
  it.each<[string, Mode, string]>([
    ['e', USER_EXEC, 'e'],
    ['e', PRIV_EXEC, 'e'],
    ['e', IF, 'e'],
    ['do e', GLOBAL_CONFIG, 'do e'],
  ])('%j in %o is ambiguous', (input, mode, quoted) => {
    expect(parse(input, mode, demoTree)).toEqual({
      kind: 'error',
      error: { kind: 'ambiguous', input: quoted },
    });
  });

  it.each<[string, Mode, number]>([
    ['shw version', PRIV_EXEC, 2],
    ['show verzion', PRIV_EXEC, 8],
    ['  shw', PRIV_EXEC, 4],
    ['show version extra', PRIV_EXEC, 13],
    ['configure terminal', USER_EXEC, 0],
    ['hostname R1', PRIV_EXEC, 0],
    ['interface x0/0', GLOBAL_CONFIG, 10],
    ['ip address 10.0.0.300 255.255.255.0', IF, 11],
    ['ip address 10.0.0.1 255.0.255.0', IF, 20],
    ['no interface g0/0', GLOBAL_CONFIG, 3],
    ['no shutdown', PRIV_EXEC, 0],
    ['do show version', PRIV_EXEC, 1],
    ['do hostname R1', GLOBAL_CONFIG, 3],
  ])('%j in %o is invalid at column %i', (input, mode, column) => {
    expect(parse(input, mode, demoTree)).toEqual({
      kind: 'error',
      error: { kind: 'invalid', column },
    });
  });

  it.each<[string, Mode]>([
    ['configure', PRIV_EXEC],
    ['show', PRIV_EXEC],
    ['interface', GLOBAL_CONFIG],
    ['interface GigabitEthernet', GLOBAL_CONFIG],
    ['interface range f0/1 -', GLOBAL_CONFIG],
    ['ip address 10.0.0.1', IF],
    ['no', IF],
    ['no ip', IF],
    ['do', GLOBAL_CONFIG],
  ])('%j in %o is incomplete', (input, mode) => {
    expect(parse(input, mode, demoTree)).toEqual({
      kind: 'error',
      error: { kind: 'incomplete' },
    });
  });
});

describe('demo commands: no and do', () => {
  it.each<[string, Mode, string, object]>([
    ['no shut', IF, 'shutdown', {}],
    ['no ip address', IF, 'ip address', {}],
    ['no ip add 10.0.0.1 255.0.0.0', IF, 'ip address', { ip: '10.0.0.1', mask: '255.0.0.0' }],
    ['no hostname', GLOBAL_CONFIG, 'hostname', {}],
    ['no host R2', GLOBAL_CONFIG, 'hostname', { name: 'R2' }],
  ])('%j negates %s', (input, mode, command, args) => {
    expect(parse(input, mode, demoTree)).toMatchObject({
      kind: 'command',
      command,
      negated: true,
      args,
      mode,
    });
  });

  it.each<[string, Mode]>([
    ['do sh ver', GLOBAL_CONFIG],
    ['do show version', IF],
    ['do conf t', GLOBAL_CONFIG],
    ['do disable', LINE],
  ])('%j runs an exec command and stays in %o', (input, mode) => {
    expect(parse(input, mode, demoTree)).toMatchObject({ kind: 'command', mode });
  });
});

describe('demo commands: mode transitions', () => {
  it.each<[string, Mode, Mode]>([
    ['enable', USER_EXEC, PRIV_EXEC],
    ['enable', PRIV_EXEC, PRIV_EXEC],
    ['disable', PRIV_EXEC, USER_EXEC],
    ['exit', PRIV_EXEC, USER_EXEC],
    ['exit', USER_EXEC, USER_EXEC],
    ['configure terminal', PRIV_EXEC, GLOBAL_CONFIG],
    ['exit', GLOBAL_CONFIG, PRIV_EXEC],
    ['end', GLOBAL_CONFIG, PRIV_EXEC],
    ['interface Gi 0/0', GLOBAL_CONFIG, IF],
    [
      'int fa0/1',
      IF,
      { kind: 'interface-config', interfaces: ['FastEthernet0/1' as InterfaceName] },
    ],
    ['exit', IF, GLOBAL_CONFIG],
    ['end', IF, PRIV_EXEC],
    ['exit', LINE, GLOBAL_CONFIG],
    ['end', ROUTER, PRIV_EXEC],
    ['hostname R1', GLOBAL_CONFIG, GLOBAL_CONFIG],
  ])('%j moves %o to %o', (input, from, to) => {
    expect(parse(input, from, demoTree)).toMatchObject({ kind: 'command', mode: to });
  });

  it('enters a range of interfaces with a range prompt', () => {
    const s = session();
    s.run('enable');
    s.run('conf t');
    s.run('int range f0/1 - 3');
    expect(s.prompt).toBe('Router(config-if-range)#');
    s.run('shutdown');
    expect([...s.shutdown.keys()]).toEqual([
      'FastEthernet0/1',
      'FastEthernet0/2',
      'FastEthernet0/3',
    ]);
  });

  it('runs a configuration session end to end', () => {
    const s = session();
    const transcript = [
      'enable',
      'conf t',
      'hostname R1',
      'int g0/0',
      'ip add 10.0.0.1 255.255.255.0',
      'no shut',
      'do sh ver',
      'shw',
      'end',
    ].map((line) => {
      const before = s.prompt;
      return [`${before}${line}`, ...s.run(line)];
    });
    expect(transcript).toEqual([
      ['Router>enable'],
      ['Router#conf t'],
      ['Router(config)#hostname R1'],
      ['R1(config)#int g0/0'],
      ['R1(config-if)#ip add 10.0.0.1 255.255.255.0'],
      ['R1(config-if)#no shut'],
      [
        'R1(config-if)#do sh ver',
        'Tracer IOS Software, Version 0.1 (demo)',
        'R1 uptime is 0 minutes',
      ],
      ['R1(config-if)#shw', '                ^', "% Invalid input detected at '^' marker."],
      ['R1(config-if)#end'],
    ]);
    expect(s.prompt).toBe('R1#');
    expect(s.addresses.get(g00)).toEqual({ ip: '10.0.0.1', mask: '255.255.255.0' });
    expect(s.shutdown.get(g00)).toBe(false);
  });

  it('resets the hostname with no hostname', () => {
    const s = session();
    for (const line of ['en', 'conf t', 'hostname R9', 'no hostname']) s.run(line);
    expect(s.prompt).toBe('Router(config)#');
  });
});

describe('demo commands: ? help', () => {
  const names = (input: string, mode: Mode) => {
    const result = help(input, mode, demoTree);
    if (result.kind !== 'options') throw new Error(result.kind);
    return result.options.map((o) => o.name);
  };

  it.each<[string, Mode, string[]]>([
    ['', USER_EXEC, ['enable', 'exit', 'show']],
    ['', PRIV_EXEC, ['configure', 'disable', 'enable', 'exit', 'show']],
    ['', GLOBAL_CONFIG, ['do', 'end', 'exit', 'hostname', 'interface', 'no']],
    ['', IF, ['do', 'end', 'exit', 'interface', 'ip', 'no', 'shutdown']],
    ['configure ', PRIV_EXEC, ['terminal']],
    ['show ', PRIV_EXEC, ['version']],
    ['show version ', PRIV_EXEC, ['<cr>']],
    ['hostname ', GLOBAL_CONFIG, ['WORD']],
    ['ip address ', IF, ['A.B.C.D']],
    ['ip address 10.0.0.1 255.255.255.0 ', IF, ['<cr>']],
    ['no ', IF, ['ip', 'shutdown']],
    ['no ip address ', IF, ['A.B.C.D', '<cr>']],
    ['no shutdown ', IF, ['<cr>']],
    ['do ', GLOBAL_CONFIG, ['configure', 'disable', 'enable', 'exit', 'show']],
    [
      'interface ',
      GLOBAL_CONFIG,
      ['Ethernet', 'FastEthernet', 'GigabitEthernet', 'Loopback', 'Serial', 'Vlan', 'range'],
    ],
  ])('%j in %o lists %o', (input, mode, expected) => {
    expect(names(input, mode)).toEqual(expected);
  });

  it.each<[string, Mode, string[]]>([
    ['e', PRIV_EXEC, ['enable', 'exit']],
    ['sh', PRIV_EXEC, ['show']],
    ['conf t', PRIV_EXEC, ['terminal']],
    ['int g', GLOBAL_CONFIG, ['GigabitEthernet']],
    ['no s', IF, ['shutdown']],
    ['host R', GLOBAL_CONFIG, ['WORD']],
  ])('%j? in %o lists %o', (input, mode, words) => {
    expect(help(input, mode, demoTree)).toEqual({ kind: 'words', words });
  });

  it('reports errors in the line before the ?', () => {
    expect(help('shw ', PRIV_EXEC, demoTree)).toEqual({
      kind: 'error',
      error: { kind: 'invalid', column: 2 },
    });
    expect(help('e ', PRIV_EXEC, demoTree)).toEqual({
      kind: 'error',
      error: { kind: 'ambiguous', input: 'e' },
    });
    expect(help('xyz', PRIV_EXEC, demoTree)).toEqual({
      kind: 'error',
      error: { kind: 'unrecognized' },
    });
  });
});

describe('demo commands: Tab completion', () => {
  it.each<[string, Mode, string | undefined]>([
    ['conf', PRIV_EXEC, 'configure '],
    ['conf t', PRIV_EXEC, 'conf terminal '],
    ['sh', PRIV_EXEC, 'show '],
    ['show', PRIV_EXEC, 'show '],
    ['int g', GLOBAL_CONFIG, 'int GigabitEthernet'],
    ['no sh', IF, 'no shutdown '],
    ['do sh', GLOBAL_CONFIG, 'do show '],
    ['e', PRIV_EXEC, undefined],
    ['xyz', PRIV_EXEC, undefined],
    ['show ', PRIV_EXEC, undefined],
    ['shw v', PRIV_EXEC, undefined],
  ])('%j in %o completes to %j', (input, mode, line) => {
    expect(complete(input, mode, demoTree).line).toBe(line);
  });

  it('returns every candidate when the prefix is ambiguous', () => {
    expect(complete('e', PRIV_EXEC, demoTree).candidates).toEqual(['enable', 'exit']);
  });
});
