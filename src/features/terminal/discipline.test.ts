import { Terminal } from '@xterm/headless';
import { describe, expect, it } from 'vitest';
import { createDeviceSession } from '@/cli';
import { consoleOn, router } from '@/cli/device/testing';
import { decode, feed, initialState, reduce } from './discipline';
import { deviceTerminal } from './session';

const UP = '\x1b[A';
const DOWN = '\x1b[B';
const LEFT = '\x1b[D';
const RIGHT = '\x1b[C';
const HOME = '\x1b[H';
const END = '\x1b[F';
const BACKSPACE = '\x7f';
const CTRL = { A: '\x01', C: '\x03', E: '\x05', U: '\x15', W: '\x17', Z: '\x1a' };

/** A router's console in an editor store, as the app binds it. */
function routerSession() {
  const { store, device } = consoleOn(router());
  return { store, id: device.id, session: deviceTerminal(store, device.id, createDeviceSession()) };
}

/** Drives the discipline against a router's console and renders its output in a real terminal. */
async function console_(cols = 80, rows = 24) {
  const term = new Terminal({ cols, rows, allowProposedApi: true });
  const { session, store, id } = routerSession();
  let state = initialState(cols, rows);
  const write = (data: string) => new Promise<void>((resolve) => term.write(data, resolve));
  await write(session.prompt);
  const buffer = () => term.buffer.active;
  return {
    async type(data: string) {
      const step = feed(state, data, session);
      state = step.state;
      await write(step.out);
    },
    /** Every row through the cursor and the last row with text, right-trimmed. */
    screen() {
      const b = buffer();
      const rows = Array.from({ length: b.length }, (_, y) =>
        b.getLine(y)!.translateToString(true).trimEnd(),
      );
      const last = Math.max(b.baseY + b.cursorY, rows.findLastIndex(Boolean));
      return rows.slice(0, last + 1);
    },
    lastRow() {
      return this.screen().at(-1);
    },
    cursorX: () => buffer().cursorX,
    get line() {
      return state.line;
    },
    get history() {
      return state.history;
    },
    get device() {
      return store.getState().topology.devices[id];
    },
    store,
  };
}

describe('decode', () => {
  it('splits text, control keys and escape sequences', () => {
    expect(decode('ab\x1b[Dc\r\x1bOH\x1b[3~?')).toEqual([
      { kind: 'text', text: 'ab' },
      { kind: 'left' },
      { kind: 'text', text: 'c' },
      { kind: 'enter' },
      { kind: 'home' },
      { kind: 'delete' },
      { kind: 'help' },
    ]);
  });

  it('treats CRLF as one Enter and ignores unknown escapes', () => {
    expect(decode('a\r\nb\x1b[99Xc')).toEqual([
      { kind: 'text', text: 'a' },
      { kind: 'enter' },
      { kind: 'text', text: 'b' },
      { kind: 'text', text: 'c' },
    ]);
  });
});

describe('line editing', () => {
  it('echoes typed text after the prompt', async () => {
    const t = await console_();
    await t.type('en');
    expect(t.screen()).toEqual(['Router>en']);
    expect(t.cursorX()).toBe('Router>en'.length);
  });

  it('inserts at the cursor after moving left', async () => {
    const t = await console_();
    await t.type(`sh ver${LEFT}${LEFT}${LEFT}x`);
    expect(t.lastRow()).toBe('Router>sh xver');
    expect(t.cursorX()).toBe('Router>sh x'.length);
    await t.type(`${RIGHT}${END}!`);
    expect(t.line).toBe('sh xver!');
  });

  it('Home, End, Ctrl+A and Ctrl+E jump to the ends of the line', async () => {
    const t = await console_();
    await t.type(`how${CTRL.A}s${CTRL.E} ver`);
    expect(t.lastRow()).toBe('Router>show ver');
    await t.type(`${HOME}`);
    expect(t.cursorX()).toBe('Router>'.length);
    await t.type(`${END}`);
    expect(t.cursorX()).toBe('Router>show ver'.length);
  });

  it('Backspace deletes before the cursor, at the end and mid-line', async () => {
    const t = await console_();
    await t.type(`shoxww${BACKSPACE}${LEFT}${BACKSPACE}`);
    expect(t.lastRow()).toBe('Router>show');
  });

  it('Ctrl+U clears to the start and Ctrl+W deletes the previous word', async () => {
    const t = await console_();
    await t.type(`garbage${CTRL.U}show version junk${CTRL.W}`);
    expect(t.lastRow()).toBe('Router>show version');
    expect(t.line).toBe('show version ');
  });

  it('Ctrl+C abandons the line', async () => {
    const t = await console_();
    await t.type(`show${CTRL.C}`);
    expect(t.screen()).toEqual(['Router>show^C', 'Router>']);
    expect(t.line).toBe('');
  });

  it('keeps a wrapped line consistent while editing it', async () => {
    const t = await console_(20, 10);
    // 'Router>' plus 13 characters fills the first row exactly.
    await t.type('show version ');
    expect(t.screen()).toEqual(['Router>show version', '']);
    await t.type('x');
    expect(t.screen()).toEqual(['Router>show version', 'x']);
    await t.type(`${HOME}${CTRL.E}${BACKSPACE}`);
    expect(t.screen()).toEqual(['Router>show version', '']);
    await t.type(`${CTRL.A}!`);
    expect(t.screen()).toEqual(['Router>!show version']);
    expect(t.cursorX()).toBe('Router>!'.length);
    await t.type(`${END}ab${CTRL.U}`);
    expect(t.screen()).toEqual(['Router>']);
    await t.type('enable\r');
    expect(t.screen()).toEqual(['Router>enable', 'Router#']);
  });
});

describe('history', () => {
  it('Up and Down walk past commands and restore the draft', async () => {
    const t = await console_();
    await t.type('enable\rconfigure terminal\rho');
    await t.type(UP);
    expect(t.lastRow()).toBe('Router(config)#configure terminal');
    await t.type(UP);
    expect(t.lastRow()).toBe('Router(config)#enable');
    await t.type(UP);
    expect(t.line).toBe('enable');
    await t.type(DOWN);
    expect(t.line).toBe('configure terminal');
    await t.type(DOWN);
    expect(t.lastRow()).toBe('Router(config)#ho');
  });

  it('runs a recalled command', async () => {
    const t = await console_();
    await t.type(`show version\r${UP}\r`);
    expect(t.screen().filter((row) => row.startsWith('Tracer IOS'))).toHaveLength(2);
  });
});

describe('Tab', () => {
  it('completes a single candidate in place', async () => {
    const t = await console_();
    await t.type('ena\t');
    expect(t.lastRow()).toBe('Router>enable');
    expect(t.line).toBe('enable ');
  });

  it('lists several candidates and redraws the prompt and line', async () => {
    const t = await console_();
    await t.type('e\t');
    expect(t.screen()).toEqual(['Router>e', 'enable  exit', 'Router>e']);
    await t.type('n\t');
    expect(t.line).toBe('enable ');
  });
});

describe('?', () => {
  it('shows help at once, then redraws the partial line', async () => {
    const t = await console_();
    await t.type('sh?');
    expect(t.screen()).toEqual(['Router>sh?', 'show', 'Router>sh']);
    expect(t.line).toBe('sh');
    expect(t.cursorX()).toBe('Router>sh'.length);
  });

  it('mid-line, helps with the text before the cursor and keeps the cursor in place', async () => {
    const t = await console_();
    await t.type(`show version${LEFT}${LEFT}${LEFT}${LEFT}?`);
    expect(t.screen()).toEqual(['Router>show version', 'version', 'Router>show version']);
    expect(t.cursorX()).toBe('Router>show ver'.length);
  });
});

describe('Enter', () => {
  it('runs the line, prints its output and shows the new prompt', async () => {
    const t = await console_();
    await t.type('enable\rshow version\r');
    const screen = t.screen();
    expect(screen.slice(0, 2)).toEqual(['Router>enable', 'Router#show version']);
    expect(screen[2]).toMatch(/^Tracer IOS Software/);
    expect(screen).toContain('Router uptime is 0 minutes');
    expect(screen.at(-1)).toBe('Router#');
  });

  it('puts the error caret under the bad character', async () => {
    const t = await console_();
    await t.type('enable\rconfigure terminal\rhostnme R1\r');
    const [command, caret, message, prompt] = t.screen().slice(-4);
    expect(command).toBe('Router(config)#hostnme R1');
    expect(caret!.indexOf('^')).toBe('Router(config)#hostn'.length);
    expect(message).toBe("% Invalid input detected at '^' marker.");
    expect(prompt).toBe('Router(config)#');
  });

  it('runs the whole line when the cursor is mid-line', async () => {
    const t = await console_();
    await t.type(`enable${HOME}\r`);
    expect(t.screen()).toEqual(['Router>enable', 'Router#']);
  });
});

describe('Ctrl+Z', () => {
  it('leaves config mode for privileged EXEC', async () => {
    const t = await console_();
    await t.type(`enable\rconf t\rint g0/0\r${CTRL.Z}`);
    expect(t.screen().slice(-2)).toEqual(['Router(config-if)#^Z', 'Router#']);
  });
});

describe('paste', () => {
  it('runs each pasted line in order', async () => {
    const t = await console_();
    await t.type(
      'enable\nconfigure terminal\nhostname R1\ninterface g0/0\nip address 10.0.0.1 255.255.255.0\nend\n',
    );
    expect(t.screen()).toEqual([
      'Router>enable',
      'Router#configure terminal',
      'Enter configuration commands, one per line.  End with CNTL/Z.',
      'Router(config)#hostname R1',
      'R1(config)#interface g0/0',
      'R1(config-if)#ip address 10.0.0.1 255.255.255.0',
      'R1(config-if)#end',
      'R1#',
    ]);
  });
});

describe('--More--', () => {
  it('pages long output: Space for a page, Enter for a line', async () => {
    const { session } = routerSession();
    session.run('enable');
    const total = session.help('').length;
    const t = await console_(80, 3);
    await t.type('enable\r?');
    const options = () => t.screen().filter((row) => row.startsWith('  '));
    expect(t.lastRow()).toBe(' --More--');
    expect(options()).toHaveLength(2);
    await t.type('\r');
    expect(t.lastRow()).toBe(' --More--');
    expect(options()).toHaveLength(3);
    await t.type(' ');
    expect(options()).toHaveLength(Math.min(5, total));
    for (let page = 0; page < total && t.lastRow() !== 'Router#'; page++) await t.type(' ');
    expect(t.lastRow()).toBe('Router#');
    expect(options()).toHaveLength(total);
    expect(t.screen().join('\n')).not.toContain('--More--');
  });

  it('any other key stops paging and keeps the typed line', async () => {
    const t = await console_(80, 3);
    await t.type('?q');
    expect(t.lastRow()).toBe('Router>');
    await t.type('en');
    expect(t.line).toBe('en');
  });
});

it('pages to the size the terminal reports', () => {
  const { session } = routerSession();
  let state = initialState(80, 24);
  state = reduce(state, { kind: 'resize', cols: 80, rows: 2 }, session).state;
  expect(feed(state, '?', session).out).toContain('--More--');
});

describe('password prompts', () => {
  async function withEnableSecret() {
    const t = await console_();
    await t.type('enable\rconfigure terminal\renable secret class\rend\rdisable\r');
    return t;
  }

  it('echoes nothing while reading a password and keeps it out of history', async () => {
    const t = await withEnableSecret();
    await t.type('enable\r');
    expect(t.lastRow()).toBe('Password:');
    await t.type(`cl?x${BACKSPACE}${BACKSPACE}ass`);
    expect(t.lastRow()).toBe('Password:');
    expect(t.line).toBe('class');
    await t.type('\r');
    expect(t.screen().slice(-3)).toEqual(['Router>enable', 'Password:', 'Router#']);
    expect(t.history).not.toContain('class');
    expect(t.history.at(-1)).toBe('enable');
  });

  it('a pasted password runs without echo, then the next line echoes again', async () => {
    const t = await withEnableSecret();
    await t.type('enable\nclass\ndisable\n');
    expect(t.screen().slice(-4)).toEqual([
      'Router>enable',
      'Password:',
      'Router#disable',
      'Router>',
    ]);
  });

  it('commits each config line as its own undo step', async () => {
    const t = await console_();
    await t.type('enable\rconf t\rhostname EDGE\rinterface g0/0\rno shutdown\rend\r');
    expect(t.device?.config.hostname).toBe('EDGE');
    expect(t.store.temporal.getState().pastStates).toHaveLength(2);
    t.store.getState().undo();
    expect(t.device?.config.hostname).toBe('EDGE');
    t.store.getState().undo();
    expect(t.device?.config.hostname).toBe('Router');
  });
});
