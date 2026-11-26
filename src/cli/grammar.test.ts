import { describe, expect, it } from 'vitest';
import type { InterfaceId } from '../model';
import { exitMode, GLOBAL_CONFIG, PRIV_EXEC, USER_EXEC, type Mode } from './modes';
import { iface, ifaceRange, ipv4, keyword, mask, word } from './params';
import { complete, help, parse } from './parser';
import { buildTree, defineCommand } from './tree';

/** What the fixture commands change. The grammar tests only parse, so nothing implements it. */
interface Context {
  readonly hostname: string;
  setHostname(name: string): void;
  setAddress(name: InterfaceId, address: { ip: string; mask: number } | undefined): void;
  setShutdown(name: InterfaceId, shutdown: boolean): void;
}

const DEFAULT_HOSTNAME = 'Router';

// A small IOS command set, shaped like the device commands, to pin down how the parser reads them.
const EXEC = ['user-exec', 'priv-exec'] as const;
const CONFIG = ['global-config', 'interface-config', 'line-config', 'rip-config'] as const;

const command = defineCommand<Context>();
const show = keyword('show', 'Show running system information');
const interfaceKw = keyword('interface', 'Select an interface to configure');
const ipKw = keyword('ip', 'Interface Internet Protocol config commands');
const address = keyword('address', 'Set the IP address of an interface');

const commands = [
  command({ modes: EXEC, path: [keyword('enable', 'Turn on privileged commands')], to: PRIV_EXEC }),
  command({
    modes: ['priv-exec'],
    path: [keyword('disable', 'Turn off privileged commands')],
    to: USER_EXEC,
  }),
  command({ modes: EXEC, path: [keyword('exit', 'Exit from the EXEC')], to: USER_EXEC }),
  command({
    modes: ['priv-exec'],
    path: [
      keyword('configure', 'Enter configuration mode'),
      keyword('terminal', 'Configure from the terminal'),
    ],
    to: GLOBAL_CONFIG,
  }),
  command({
    modes: EXEC,
    path: [show, keyword('version', 'System hardware and software status')],
    run: (_args, ctx) => [
      'Tracer IOS Software, Version 0.1 (fixture)',
      `${ctx.hostname} uptime is 0 minutes`,
    ],
  }),
  command({
    modes: CONFIG,
    path: [keyword('exit', 'Exit from configure mode')],
    to: (_args, from) => exitMode(from),
  }),
  command({ modes: CONFIG, path: [keyword('end', 'Exit from configure mode')], to: PRIV_EXEC }),
  command({
    modes: ['global-config'],
    path: [
      keyword('hostname', "Set system's network name"),
      word('name', "This system's network name"),
    ],
    run: ({ name }, ctx) => {
      ctx.setHostname(name);
      return [];
    },
    no: (_args, ctx) => {
      ctx.setHostname(DEFAULT_HOSTNAME);
      return [];
    },
  }),
  command({
    modes: ['global-config'],
    path: [interfaceKw, iface('name', 'Interface name')],
    to: ({ name }) => ({ kind: 'interface-config', interfaces: [name] }),
  }),
  command({
    modes: ['global-config'],
    path: [
      interfaceKw,
      keyword('range', 'interface range command'),
      ifaceRange('names', 'Interface range'),
    ],
    to: ({ names }) => ({ kind: 'interface-config', interfaces: names }),
  }),
  command({
    modes: ['interface-config'],
    path: [ipKw, address, ipv4('ip', 'IP address'), mask('mask', 'IP subnet mask')],
    run: ({ ip, mask }, ctx, mode) => {
      for (const name of mode.interfaces) ctx.setAddress(name, { ip, mask });
      return [];
    },
    no: (_args, ctx, mode) => {
      for (const name of mode.interfaces) ctx.setAddress(name, undefined);
      return [];
    },
  }),
  command({
    modes: ['interface-config'],
    path: [keyword('shutdown', 'Shutdown the selected interface')],
    run: (_args, ctx, mode) => {
      for (const name of mode.interfaces) ctx.setShutdown(name, true);
      return [];
    },
    no: (_args, ctx, mode) => {
      for (const name of mode.interfaces) ctx.setShutdown(name, false);
      return [];
    },
  }),
];

const tree = buildTree(commands);

const g00 = 'GigabitEthernet0/0' as InterfaceId;
const IF: Mode = { kind: 'interface-config', interfaces: [g00] };
const LINE: Mode = { kind: 'line-config', line: { kind: 'console' } };
const ROUTER: Mode = { kind: 'rip-config' };

describe('grammar: abbreviation', () => {
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
    expect(parse(input, mode, tree)).toMatchObject({ kind: 'command', command });
  });

  it('keeps the case of a WORD argument', () => {
    expect(parse('host Core-R1', GLOBAL_CONFIG, tree)).toMatchObject({
      args: { name: 'Core-R1' },
    });
  });

  it('types the ip address args', () => {
    expect(parse('ip add 10.0.0.1 255.255.255.0', IF, tree)).toMatchObject({
      args: { ip: '10.0.0.1', mask: 24 },
    });
  });
});

describe('grammar: errors', () => {
  it.each<[string, Mode, string]>([
    ['e', USER_EXEC, 'e'],
    ['e', PRIV_EXEC, 'e'],
    ['e', IF, 'e'],
    ['do e', GLOBAL_CONFIG, 'do e'],
  ])('%j in %o is ambiguous', (input, mode, quoted) => {
    expect(parse(input, mode, tree)).toEqual({
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
    expect(parse(input, mode, tree)).toEqual({
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
    expect(parse(input, mode, tree)).toEqual({
      kind: 'error',
      error: { kind: 'incomplete' },
    });
  });
});

describe('grammar: no and do', () => {
  it.each<[string, Mode, string, object]>([
    ['no shut', IF, 'shutdown', {}],
    ['no ip address', IF, 'ip address', {}],
    ['no ip add 10.0.0.1 255.0.0.0', IF, 'ip address', { ip: '10.0.0.1', mask: 8 }],
    ['no hostname', GLOBAL_CONFIG, 'hostname', {}],
    ['no host R2', GLOBAL_CONFIG, 'hostname', { name: 'R2' }],
  ])('%j negates %s', (input, mode, command, args) => {
    expect(parse(input, mode, tree)).toMatchObject({
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
    expect(parse(input, mode, tree)).toMatchObject({ kind: 'command', mode });
  });
});

describe('grammar: mode transitions', () => {
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
    ['int fa0/1', IF, { kind: 'interface-config', interfaces: ['FastEthernet0/1' as InterfaceId] }],
    ['exit', IF, GLOBAL_CONFIG],
    ['end', IF, PRIV_EXEC],
    ['exit', LINE, GLOBAL_CONFIG],
    ['end', ROUTER, PRIV_EXEC],
    ['hostname R1', GLOBAL_CONFIG, GLOBAL_CONFIG],
    // Global commands fall back from sub-config modes, as in IOS.
    ['hostname R1', IF, GLOBAL_CONFIG],
    ['host R1', LINE, GLOBAL_CONFIG],
    [
      'int g0/1',
      ROUTER,
      { kind: 'interface-config', interfaces: ['GigabitEthernet0/1' as InterfaceId] },
    ],
  ])('%j moves %o to %o', (input, from, to) => {
    expect(parse(input, from, tree)).toMatchObject({ kind: 'command', mode: to });
  });

  it('keeps sub-mode commands and errors local to the sub-mode', () => {
    expect(parse('shutdown', IF, tree)).toMatchObject({ kind: 'command', mode: IF });
    expect(parse('shutdown', GLOBAL_CONFIG, tree)).toMatchObject({ kind: 'error' });
    expect(parse('bogus', IF, tree)).toMatchObject({
      kind: 'error',
      error: { kind: 'invalid', column: 0 },
    });
  });
});

describe('grammar: ? help', () => {
  const names = (input: string, mode: Mode) => {
    const result = help(input, mode, tree);
    if (result.kind !== 'options') throw new Error(result.kind);
    return result.options.map((o) => o.name);
  };

  it.each<[string, Mode, string[]]>([
    ['', USER_EXEC, ['enable', 'exit', 'show']],
    ['', PRIV_EXEC, ['configure', 'disable', 'enable', 'exit', 'show']],
    ['', GLOBAL_CONFIG, ['do', 'end', 'exit', 'hostname', 'interface', 'no']],
    ['', IF, ['do', 'end', 'exit', 'ip', 'no', 'shutdown']],
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
      ['FastEthernet', 'GigabitEthernet', 'Loopback', 'Port-channel', 'Serial', 'Vlan', 'range'],
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
    expect(help(input, mode, tree)).toEqual({ kind: 'words', words });
  });

  it('reports errors in the line before the ?', () => {
    expect(help('shw ', PRIV_EXEC, tree)).toEqual({
      kind: 'error',
      error: { kind: 'invalid', column: 2 },
    });
    expect(help('e ', PRIV_EXEC, tree)).toEqual({
      kind: 'error',
      error: { kind: 'ambiguous', input: 'e' },
    });
    expect(help('xyz', PRIV_EXEC, tree)).toEqual({
      kind: 'error',
      error: { kind: 'unrecognized' },
    });
  });
});

describe('grammar: Tab completion', () => {
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
    expect(complete(input, mode, tree).line).toBe(line);
  });

  it('returns every candidate when the prefix is ambiguous', () => {
    expect(complete('e', PRIV_EXEC, tree).candidates).toEqual(['enable', 'exit']);
  });
});
