// @vitest-environment node
import { Terminal } from '@xterm/headless';
import { describe, expect, it, vi } from 'vitest';
import { after, ms } from '@/engine/core/time';
import { createEngine } from '@/engine/engine';
import { diffTopology } from '@/engine/patch';
import { createSimService } from '@/engine/service';
import { STACKS } from '@/engine/stacks';
import { ip, labBuilder, STP_CONVERGED } from '@/engine/testing';
import type { OutputStream } from '@/cli';
import { createIdSource } from '@/model';
import { createEditorStore } from '@/model/store';
import { createConsoleRegistry } from './registry';
import type { SimLink } from './session';
import { createTty, type Tty } from './tty';

const SIZE = { cols: 100, rows: 200 };

async function rows(tty: Tty): Promise<string[]> {
  const term = new Terminal({ ...SIZE, allowProposedApi: true });
  await new Promise<void>((resolve) => term.write(tty.transcript, resolve));
  const buffer = term.buffer.active;
  const lines = Array.from({ length: buffer.length }, (_, y) =>
    buffer.getLine(y)!.translateToString(true).trimEnd(),
  );
  return lines.slice(0, buffer.baseY + buffer.cursorY + 1);
}

/**
 * The router-on-a-stick lab, uncabled to config: R1 and SW1 start blank, and the store feeds every
 * edit to a simulation, as the app's worker client does.
 */
function lab() {
  const build = labBuilder();
  const sw1 = build.switch('SW1');
  const r1 = build.router('R1', {});
  const pc1 = build.host('pc', 'PC1', '192.168.10.10/24', '192.168.10.1');
  const pc2 = build.host('pc', 'PC2', '192.168.20.10/24', '192.168.20.1');
  build.connect(pc1, 'FastEthernet0', sw1, 'FastEthernet0/1');
  build.connect(pc2, 'FastEthernet0', sw1, 'FastEthernet0/2');
  build.connect(sw1, 'GigabitEthernet0/1', r1, 'GigabitEthernet0/0');

  const store = createEditorStore({ topology: build.topology, ids: createIdSource(9) });
  const engine = createEngine({ seed: 1, stacks: STACKS, linkDelay: ms(1) });
  const sim = createSimService({ engine, frames: { now: () => 0, request: () => {} } });
  let synced = build.topology;
  sim.load(synced);
  store.subscribe(({ topology }) => {
    const patch = diffTopology(synced, topology);
    synced = topology;
    if (patch) sim.applyPatch(patch);
  });
  const queries: SimLink = {
    routes: async (device) => sim.routes(device),
    arpTable: async (device) => sim.arpTable(device),
    macTable: async (device) => sim.macTable(device),
    portStates: async (device) => sim.portStates(device),
    now: () => engine.now,
    ping: async (...args) => sim.ping(...args),
  };
  const consoles = createConsoleRegistry(store, async () => queries);
  /** Runs until spanning tree forwards: a port a config change moved into a VLAN starts over. */
  const converge = () => engine.runUntil(after(engine.now, ms(STP_CONVERGED)));
  /** Pings and runs the simulation until the ping is over, once spanning tree forwards. */
  const ping = (from: typeof pc1, target: string) => {
    converge();
    let done = false;
    sim.ping(from, ip(target), { count: 2, timeoutMs: 1000 }, (event) => {
      done ||= event.kind === 'summary';
    });
    while (!done && engine.nextTime() !== undefined) engine.step();
  };
  /**
   * Runs the simulation until `tty` shows its prompt again, as a playing simulation would. It lets
   * the console print after every event, since spanning tree's timers never leave the queue empty.
   */
  const runUntilPrompt = async (tty: Tty, prompt: string) => {
    for (let i = 0; i < 10_000 && !tty.transcript.endsWith(prompt); i++) {
      if (engine.nextTime() !== undefined) engine.step();
      await new Promise(setImmediate);
    }
  };
  return {
    consoles,
    r1: consoles.get(r1)!,
    sw1: consoles.get(sw1)!,
    pc1,
    converge,
    ping,
    runUntilPrompt,
  };
}

/** Types lines into a console, one at a time, waiting for each prompt to come back. */
async function type(tty: Tty, lines: readonly string[]) {
  for (const line of lines) {
    tty.input(`${line}\r`, SIZE);
    await vi.waitFor(async () => expect((await rows(tty)).at(-1)).toMatch(/[>#]$/));
  }
}

const R1_CONFIG = [
  'enable',
  'configure terminal',
  'interface g0/0',
  'no shutdown',
  'interface g0/0.10',
  'encapsulation dot1Q 10',
  'ip address 192.168.10.1 255.255.255.0',
  'interface g0/0.20',
  'encapsulation dot1Q 20',
  'ip address 192.168.20.1 255.255.255.0',
  'end',
];

const SW1_CONFIG = [
  'enable',
  'configure terminal',
  'interface f0/1',
  'switchport mode access',
  'switchport access vlan 10',
  'interface f0/2',
  'switchport mode access',
  'switchport access vlan 20',
  'interface g0/1',
  'switchport mode trunk',
  'end',
];

describe('a console reading live state', () => {
  it('builds router-on-a-stick from the CLI and shows the routes and MACs it uses', async () => {
    const { r1, sw1, pc1, ping } = lab();
    await type(r1, R1_CONFIG);
    await type(sw1, SW1_CONFIG);
    ping(pc1, '192.168.20.10');

    await type(r1, ['show ip route']);
    const routes = await rows(r1);
    expect(routes.slice(routes.indexOf('R1#show ip route') + 9)).toEqual([
      'Gateway of last resort is not set',
      '',
      '      192.168.10.0/24 is variably subnetted, 2 subnets, 2 masks',
      'C        192.168.10.0/24 is directly connected, GigabitEthernet0/0.10',
      'L        192.168.10.1/32 is directly connected, GigabitEthernet0/0.10',
      '      192.168.20.0/24 is variably subnetted, 2 subnets, 2 masks',
      'C        192.168.20.0/24 is directly connected, GigabitEthernet0/0.20',
      'L        192.168.20.1/32 is directly connected, GigabitEthernet0/0.20',
      'R1#',
    ]);

    await type(sw1, ['show mac address-table']);
    const table = await rows(sw1);
    const learned = table.filter((row) => /^\s+\d+\s+[0-9a-f.]{14}\s+DYNAMIC/.test(row));
    const byVlanThenPort = learned
      .map((row) => row.trim().split(/\s+/))
      .sort((a, b) => `${a[0]} ${a[3]}`.localeCompare(`${b[0]} ${b[3]}`));
    expect(byVlanThenPort).toEqual([
      ['10', expect.any(String), 'DYNAMIC', 'Fa0/1'],
      ['10', expect.any(String), 'DYNAMIC', 'Gi0/1'],
      ['20', expect.any(String), 'DYNAMIC', 'Fa0/2'],
      ['20', expect.any(String), 'DYNAMIC', 'Gi0/1'],
    ]);
  });

  it('pings from the router, printing a mark per echo as the simulation settles it', async () => {
    const { r1, sw1, converge, runUntilPrompt } = lab();
    await type(r1, R1_CONFIG);
    await type(sw1, SW1_CONFIG);
    converge();

    r1.input('ping 192.168.20.10\r', SIZE);
    await runUntilPrompt(r1, '\r\nR1#');
    // R1 has no route to 192.168.30.0/24, so each echo times out, as on IOS.
    r1.input('ping 192.168.30.10 repeat 2 timeout 1\r', SIZE);
    await runUntilPrompt(r1, '\r\nR1#');

    const shown = await rows(r1);
    expect(shown.slice(shown.indexOf('R1#ping 192.168.20.10'))).toEqual([
      'R1#ping 192.168.20.10',
      'Type escape sequence to abort.',
      'Sending 5, 100-byte ICMP Echos to 192.168.20.10, timeout is 2 seconds:',
      '!!!!!',
      expect.stringMatching(
        /^Success rate is 100 percent \(5\/5\), round-trip min\/avg\/max = \d+\/\d+\/\d+ ms$/,
      ),
      'R1#ping 192.168.30.10 repeat 2 timeout 1',
      'Type escape sequence to abort.',
      'Sending 2, 100-byte ICMP Echos to 192.168.30.10, timeout is 1 seconds:',
      '..',
      'Success rate is 0 percent (0/2)',
      'R1#',
    ]);
  });

  it('shows a port with no cable as down', async () => {
    const { r1 } = lab();
    await type(r1, ['enable', 'conf t', 'int g0/1', 'no shut', 'end', 'show ip interface brief']);

    expect(await rows(r1)).toContain(
      'GigabitEthernet0/1     unassigned      YES unset  down                  down',
    );
  });
});

describe('a console without the simulation', () => {
  it('prints the config-only output when the simulation cannot be reached', async () => {
    const build = labBuilder();
    const r1 = build.router('R1', {});
    const store = createEditorStore({ topology: build.topology, ids: createIdSource(9) });
    const consoles = createConsoleRegistry(store, () => Promise.reject(new Error('no worker')));
    const tty = consoles.get(r1)!;

    await type(tty, ['enable', 'show ip route']);

    expect((await rows(tty)).slice(-2)).toEqual([
      '% The simulation is not running, so there is no live state to show.',
      'R1#',
    ]);
  });
});

describe('a tty waiting on output', () => {
  it('holds keys typed meanwhile, then runs them after the output', async () => {
    let answer: (lines: readonly string[]) => void = () => {};
    const ran: string[] = [];
    const session = {
      prompt: '> ',
      masked: false,
      run: (line: string) => {
        ran.push(line);
        if (line !== 'slow') return [`ran ${line}`];
        return new Promise<readonly string[]>((resolve) => (answer = resolve));
      },
      help: () => [],
      complete: () => ({ line: undefined, candidates: [] }),
      end: () => [],
    };
    const tty = createTty(session);

    tty.input('slow\rfast\r', SIZE);
    tty.input('next\r', SIZE);
    expect(ran).toEqual(['slow']);
    expect(await rows(tty)).toEqual(['> slow', '']);

    answer(['slow done']);
    await vi.waitFor(() => expect(ran).toEqual(['slow', 'fast', 'next']));
    expect(await rows(tty)).toEqual([
      '> slow',
      'slow done',
      '> fast',
      'ran fast',
      '> next',
      'ran next',
      '>',
    ]);
  });

  it.each([
    ['Ctrl+C', '\x03'],
    ['Ctrl+Shift+6', '\x1e'],
  ])('writes a stream as it arrives, and %s aborts it', async (_name, key) => {
    let write: (text: string) => void = () => {};
    let finish: () => void = () => {};
    const stream: OutputStream = {
      start: (next) => {
        write = next;
        return new Promise<void>((resolve) => (finish = resolve));
      },
      abort: () => {
        write('\naborted\n');
        finish();
      },
    };
    const session = {
      prompt: '> ',
      masked: false,
      run: (line: string) => (line === 'ping' ? stream : [`ran ${line}`]),
      help: () => [],
      complete: () => ({ line: undefined, candidates: [] }),
      end: () => [],
    };
    const tty = createTty(session);

    tty.input('ping\r', SIZE);
    write('head\n');
    write('!');
    write('!');
    tty.input('next\r', SIZE);
    expect(await rows(tty)).toEqual(['> ping', 'head', '!!']);

    tty.input(key, SIZE);
    await vi.waitFor(async () => expect((await rows(tty)).at(-1)).toBe('>'));
    expect(await rows(tty)).toEqual(['> ping', 'head', '!!', 'aborted', '> next', 'ran next', '>']);
  });
});
