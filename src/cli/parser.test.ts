import { describe, expect, it } from 'vitest';
import { formatError, formatHelp } from './format';
import { GLOBAL_CONFIG, PRIV_EXEC, type Mode } from './modes';
import { keyword, line, num, word } from './params';
import { complete, help, parse } from './parser';
import { buildTree, defineCommand } from './tree';

interface Ctx {
  readonly log: string[];
}

const command = defineCommand<Ctx>();
const show = keyword('show', 'Show running system information');
const IF: Mode = { kind: 'interface-config', interfaces: [] };

const tree = buildTree([
  command({
    modes: ['priv-exec'],
    path: [show, keyword('running-config', 'Current operating configuration')],
    run: () => ['! running-config'],
  }),
  command({
    modes: ['priv-exec'],
    path: [show, keyword('version', 'System hardware and software status')],
  }),
  command({
    modes: ['priv-exec'],
    path: [keyword('ssh', 'Open a secure shell client connection'), word('host', 'Host name')],
  }),
  command({
    modes: ['global-config'],
    path: [keyword('vlan', 'VLAN commands'), num('id', 1, 4094, 'ISL VLAN IDs 1-1005')],
    run: ({ id }, ctx) => {
      ctx.log.push(`vlan ${id.toFixed(0)}`);
      return [];
    },
  }),
  command({
    modes: ['interface-config'],
    path: [
      keyword('description', 'Interface specific description'),
      line('text', 'Up to 240 characters describing this interface'),
    ],
    run: ({ text }, ctx) => {
      ctx.log.push(text);
      return [];
    },
    no: (_args, ctx) => {
      ctx.log.push('(none)');
      return [];
    },
  }),
]);

describe('parse', () => {
  it.each([
    ['sh run', 'show running-config'],
    ['SH RUN', 'show running-config'],
    ['sh r', 'show running-config'],
    ['show v', 'show version'],
    ['  show   version  ', 'show version'],
  ])('%j resolves to %s', (input, command) => {
    expect(parse(input, PRIV_EXEC, tree)).toMatchObject({ kind: 'command', command });
  });

  it('reports an ambiguous prefix', () => {
    expect(parse('s', PRIV_EXEC, tree)).toEqual({
      kind: 'error',
      error: { kind: 'ambiguous', input: 's' },
    });
  });

  it('reports a command that stops early as incomplete', () => {
    expect(parse('show ', PRIV_EXEC, tree)).toEqual({
      kind: 'error',
      error: { kind: 'incomplete' },
    });
  });

  it('quotes the line up to the ambiguous token', () => {
    const ambiguous = buildTree([
      command({ modes: ['priv-exec'], path: [show, keyword('interfaces', 'Interface status')] }),
      command({ modes: ['priv-exec'], path: [show, keyword('ip', 'IP information')] }),
    ]);
    expect(parse('show i', PRIV_EXEC, ambiguous)).toEqual({
      kind: 'error',
      error: { kind: 'ambiguous', input: 'show i' },
    });
  });

  it.each([
    ['vlan 10', { id: 10 }],
    ['vlan 4094', { id: 4094 }],
  ])('%j parses a number in range', (input, args) => {
    expect(parse(input, GLOBAL_CONFIG, tree)).toMatchObject({ kind: 'command', args });
  });

  it.each([
    ['vlan 0', 5],
    ['vlan 5000', 5],
    ['vlan ten', 5],
    ['vlan 10 20', 8],
  ])('%j is invalid at column %i', (input, column) => {
    expect(parse(input, GLOBAL_CONFIG, tree)).toEqual({
      kind: 'error',
      error: { kind: 'invalid', column },
    });
  });

  it('keeps a LINE argument verbatim, inner spacing included', () => {
    const result = parse('description  Uplink to  core  ', IF, tree);
    expect(result).toMatchObject({ args: { text: 'Uplink to  core' } });
  });

  it('accepts a bare WORD', () => {
    expect(parse('ssh Core-1', PRIV_EXEC, tree)).toMatchObject({ args: { host: 'Core-1' } });
  });

  it('returns empty for a blank line', () => {
    expect(parse('   ', PRIV_EXEC, tree)).toEqual({ kind: 'empty' });
  });

  it('runs the handler with typed args through execute', () => {
    const ctx: Ctx = { log: [] };
    const result = parse('vlan 20', GLOBAL_CONFIG, tree);
    if (result.kind !== 'command') throw new Error(result.kind);
    expect(result.execute(ctx)).toEqual([]);
    expect(ctx.log).toEqual(['vlan 20']);
    const shown = parse('sh run', PRIV_EXEC, tree);
    if (shown.kind !== 'command') throw new Error(shown.kind);
    expect(shown.execute(ctx)).toEqual(['! running-config']);
  });
});

describe('help', () => {
  it('lists the options for the next token, sorted, with <cr> when complete', () => {
    expect(help('show ', PRIV_EXEC, tree)).toEqual({
      kind: 'options',
      options: [
        { name: 'running-config', help: 'Current operating configuration' },
        { name: 'version', help: 'System hardware and software status' },
      ],
    });
    expect(help('show version ', PRIV_EXEC, tree)).toEqual({
      kind: 'options',
      options: [{ name: '<cr>', help: '' }],
    });
  });

  it.each([
    ['vlan ', GLOBAL_CONFIG, '<1-4094>'],
    ['description ', IF, 'LINE'],
    ['ssh ', PRIV_EXEC, 'WORD'],
  ])('%j shows the param label', (input, mode, name) => {
    expect(help(input, mode, tree)).toMatchObject({ kind: 'options', options: [{ name }] });
  });

  it('lists keywords that start with an attached token', () => {
    expect(help('s', PRIV_EXEC, tree)).toEqual({ kind: 'words', words: ['show', 'ssh'] });
    expect(help('sh r', PRIV_EXEC, tree)).toEqual({ kind: 'words', words: ['running-config'] });
  });

  it('shows a param label when the attached token fits it', () => {
    expect(help('ssh co', PRIV_EXEC, tree)).toEqual({ kind: 'words', words: ['WORD'] });
  });

  it('reports an unrecognized prefix', () => {
    expect(help('xyz', PRIV_EXEC, tree)).toEqual({
      kind: 'error',
      error: { kind: 'unrecognized' },
    });
  });

  it('formats options as aligned IOS columns', () => {
    expect(formatHelp(help('', PRIV_EXEC, tree), 3)).toEqual([
      '  show  Show running system information',
      '  ssh   Open a secure shell client connection',
    ]);
    expect(formatHelp(help('s', PRIV_EXEC, tree), 3)).toEqual(['show  ssh']);
  });
});

describe('complete', () => {
  it('completes a unique prefix and adds a space', () => {
    expect(complete('sh r', PRIV_EXEC, tree)).toEqual({
      line: 'sh running-config ',
      candidates: ['running-config'],
    });
  });

  it('leaves an ambiguous prefix alone and returns the candidates', () => {
    expect(complete('s', PRIV_EXEC, tree)).toEqual({
      line: undefined,
      candidates: ['show', 'ssh'],
    });
  });
});

describe('formatError', () => {
  it('puts the caret under the bad character after the prompt', () => {
    const result = parse('shw version', PRIV_EXEC, tree);
    if (result.kind !== 'error') throw new Error(result.kind);
    expect(['R1#shw version', ...formatError(result.error, 'R1#'.length)]).toEqual([
      'R1#shw version',
      '     ^',
      "% Invalid input detected at '^' marker.",
    ]);
  });

  it.each([
    [{ kind: 'ambiguous', input: 's' } as const, '% Ambiguous command: "s"'],
    [{ kind: 'incomplete' } as const, '% Incomplete command.'],
  ])('formats %o', (error, text) => {
    expect(formatError(error, 3)).toEqual([text]);
  });
});

describe('buildTree', () => {
  it('rejects a duplicate command in one mode', () => {
    const cmd = command({ modes: ['priv-exec'], path: [show] });
    expect(() => buildTree([cmd, cmd])).toThrow('Duplicate command "show" in priv-exec.');
  });

  it('rejects a rest-of-line param that is not last', () => {
    expect(() =>
      command({ modes: ['priv-exec'], path: [line('text', 'Text'), keyword('x', 'X')] }),
    ).toThrow('must end its command');
  });
});
