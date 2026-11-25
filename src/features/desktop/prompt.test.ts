// @vitest-environment node
import { Terminal } from '@xterm/headless';
import { describe, expect, it, vi } from 'vitest';
import { buildOffice } from '@/features/inspector/testing';
import { Ipv4Address, type DeviceId } from '@/model';
import type { HostBackend, PingReply, TraceProbe } from './backend';
import { formatReply, isHostDevice } from './format';
import { hostShell } from './shell';
import { createHostTty, PROMPT } from './tty';

const SIZE = { cols: 80, rows: 24 };
const UP = '\x1b[A';
const ip = (text: string) => Ipv4Address.parse(text);

const reply = (timeMs: number): PingReply => ({
  kind: 'reply',
  seq: 1,
  from: ip('192.168.1.1'),
  bytes: 32,
  timeMs,
  ttl: 255,
});

type ScriptOptions = { trace: readonly TraceProbe[]; hang: boolean; learned: number };

/**
 * Answers each echo request from `script` in turn, a tick apart; after the script, it hangs. A
 * traceroute plays `trace` the same way, then is done or, with `hang`, waits for Ctrl+C. The ARP
 * cache holds `learned` entries.
 */
function scripted(
  script: readonly PingReply[],
  { trace = [], hang = false, learned = 0 }: Partial<ScriptOptions> = {},
) {
  const calls: { device: DeviceId; target: string; count: number }[] = [];
  const cleared: (string | undefined)[] = [];
  const signals: AbortSignal[] = [];
  const backend: HostBackend = {
    async ping(device, target, { count }, onReply, signal) {
      calls.push({ device, target, count });
      signals.push(signal);
      for (let sent = 0; sent < count; sent++) {
        const next = script[sent];
        if (!next) return new Promise<void>(() => {});
        await new Promise((resolve) => setTimeout(resolve, 1));
        if (signal.aborted) return;
        onReply(next);
      }
    },
    async traceroute(_device, _target, _options, onProbe, signal) {
      signals.push(signal);
      for (const probe of trace) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        if (signal.aborted) return;
        onProbe(probe);
      }
      if (hang) return new Promise<void>(() => {});
    },
    arpTable: async () => [],
    clearArp: async (_device, address) => {
      cleared.push(address);
      return address ? Math.min(learned, 1) : learned;
    },
  };
  return { backend, calls, cleared, signals };
}

/** PC1's prompt in the office lab, drawn by a real terminal. */
async function prompt(backend: HostBackend) {
  const { pc } = buildOffice();
  if (!isHostDevice(pc)) throw new Error('PC1 is not a host');
  const tty = createHostTty(hostShell({ host: () => ({ device: pc, connected: true }), backend }));
  const term = new Terminal({ ...SIZE, allowProposedApi: true });
  const written: Promise<void>[] = [];
  const write = (data: string) => {
    written.push(new Promise((resolve) => term.write(data, resolve)));
  };
  write(tty.transcript);
  tty.subscribe(write);
  const screen = async () => {
    await Promise.all(written);
    const buffer = term.buffer.active;
    const rows = Array.from({ length: buffer.length }, (_, y) =>
      buffer.getLine(y)!.translateToString(true).trimEnd(),
    );
    return rows.slice(0, buffer.baseY + buffer.cursorY + 1);
  };
  const idle = () => vi.waitFor(async () => expect((await screen()).at(-1)).toBe(PROMPT));
  return {
    tty,
    screen,
    idle,
    type: (data: string) => tty.input(data, SIZE),
    async run(line: string) {
      tty.input(`${line}\r`, SIZE);
      await idle();
      const rows = await screen();
      return rows.slice(rows.lastIndexOf(`${PROMPT}${line}`) + 1, -1);
    },
  };
}

describe('the Command Prompt', () => {
  it('greets with the prompt', async () => {
    const { screen } = await prompt(scripted([]).backend);
    expect(await screen()).toEqual([
      'Tracer Command Prompt',
      'Type help to see the commands.',
      '',
      PROMPT,
    ]);
  });

  it('streams each reply, then the summary', async () => {
    const { backend, calls } = scripted([reply(1), reply(0), reply(0), reply(0)]);
    const { run } = await prompt(backend);
    expect(await run('ping 192.168.1.1')).toEqual([
      '',
      'Pinging 192.168.1.1 with 32 bytes of data:',
      '',
      'Reply from 192.168.1.1: bytes=32 time=1ms TTL=255',
      'Reply from 192.168.1.1: bytes=32 time<1ms TTL=255',
      'Reply from 192.168.1.1: bytes=32 time<1ms TTL=255',
      'Reply from 192.168.1.1: bytes=32 time<1ms TTL=255',
      '',
      'Ping statistics for 192.168.1.1:',
      '    Packets: Sent = 4, Received = 4, Lost = 0 (0% loss),',
      'Approximate round trip times in milli-seconds:',
      '    Minimum = 0ms, Maximum = 1ms, Average = 0ms',
      '',
    ]);
    expect(calls).toEqual([{ device: 'dev_PC1', target: '192.168.1.1', count: 4 }]);
  });

  it('shows timeouts and unreachable answers as they come', async () => {
    const unreachable: PingReply = {
      kind: 'unreachable',
      seq: 2,
      from: ip('192.168.1.10'),
      code: 'host',
    };
    const { run } = await prompt(scripted([{ kind: 'timeout', seq: 1 }, unreachable]).backend);
    expect(await run('ping 192.168.1.99 -n 2')).toEqual([
      '',
      'Pinging 192.168.1.99 with 32 bytes of data:',
      '',
      'Request timed out.',
      'Reply from 192.168.1.10: Destination host unreachable.',
      '',
      'Ping statistics for 192.168.1.99:',
      '    Packets: Sent = 2, Received = 0, Lost = 2 (100% loss),',
      '',
    ]);
  });

  it('shows no prompt and ignores typing while a ping runs', async () => {
    const { screen, type } = await prompt(scripted([reply(1)]).backend);
    type('ping -n 50 192.168.1.1\r');
    await vi.waitFor(async () => expect(await screen()).toContain(formatReply(reply(1))));
    type('ipconfig\r');
    const rows = await screen();
    expect(rows.at(-1)).toBe('');
    expect(rows.join('\n')).not.toContain('ipconfig');
  });

  it('stops a running ping on Ctrl+C with the summary so far', async () => {
    const { screen, type, idle } = await prompt(scripted([reply(1), reply(0)]).backend);
    type('ping -n 50 192.168.1.1\r');
    await vi.waitFor(async () =>
      expect((await screen()).filter((r) => r.startsWith('Reply'))).toHaveLength(2),
    );
    type('\x03');
    await idle();
    expect((await screen()).slice(-9)).toEqual([
      '',
      'Ping statistics for 192.168.1.1:',
      '    Packets: Sent = 2, Received = 2, Lost = 0 (0% loss),',
      'Approximate round trip times in milli-seconds:',
      '    Minimum = 0ms, Maximum = 1ms, Average = 0ms',
      'Control-C',
      '^C',
      '',
      PROMPT,
    ]);
  });

  it('pings until Ctrl+C with -t, then stops the ping and prints the summary', async () => {
    const { backend, calls, signals } = scripted([reply(1), reply(0), reply(0)]);
    const { screen, type, idle } = await prompt(backend);
    type('ping -t 192.168.1.1\r');
    await vi.waitFor(async () =>
      expect((await screen()).filter((r) => r.startsWith('Reply'))).toHaveLength(3),
    );
    type('\x03');
    await idle();
    expect(calls).toEqual([{ device: 'dev_PC1', target: '192.168.1.1', count: Infinity }]);
    expect(signals.map((signal) => signal.aborted)).toEqual([true]);
    expect((await screen()).slice(-9, -5)).toEqual([
      '',
      'Ping statistics for 192.168.1.1:',
      '    Packets: Sent = 3, Received = 3, Lost = 0 (0% loss),',
      'Approximate round trip times in milli-seconds:',
    ]);
  });

  it('traces the route a column at a time, in Windows format', async () => {
    const hop = (n: number, from: string, times: (number | undefined)[]): TraceProbe[] =>
      times.map((timeMs, i) =>
        timeMs === undefined
          ? { kind: 'timeout', hop: n, probe: i + 1 }
          : { kind: 'ttl-expired', hop: n, probe: i + 1, from: ip(from), timeMs },
      );
    const trace: TraceProbe[] = [
      ...hop(1, '192.168.1.1', [0, 0, 1]),
      ...hop(2, '10.0.0.2', [undefined, undefined, undefined]),
      ...hop(3, '10.0.0.6', [12, undefined, 8]),
      ...[1, 2, 3].map((probe): TraceProbe => ({
        kind: 'reply',
        hop: 4,
        probe,
        from: ip('192.168.2.10'),
        timeMs: 16,
        ttl: 125,
      })),
    ];
    const { run } = await prompt(scripted([], { trace }).backend);
    expect(await run('tracert 192.168.2.10')).toEqual([
      '',
      'Tracing route to 192.168.2.10 over a maximum of 30 hops',
      '',
      '  1    <1 ms    <1 ms     1 ms  192.168.1.1',
      '  2     *        *        *     Request timed out.',
      '  3    12 ms     *        8 ms  10.0.0.6',
      '  4    16 ms    16 ms    16 ms  192.168.2.10',
      '',
      'Trace complete.',
      '',
    ]);
  });

  it("ends a trace at a router's Destination Unreachable report", async () => {
    const trace: TraceProbe[] = [
      { kind: 'ttl-expired', hop: 1, probe: 1, from: ip('192.168.1.1'), timeMs: 0 },
      { kind: 'ttl-expired', hop: 1, probe: 2, from: ip('192.168.1.1'), timeMs: 0 },
      { kind: 'ttl-expired', hop: 1, probe: 3, from: ip('192.168.1.1'), timeMs: 0 },
      {
        kind: 'unreachable',
        hop: 2,
        probe: 1,
        from: ip('192.168.1.1'),
        code: 'network',
        timeMs: 0,
      },
    ];
    const { run } = await prompt(scripted([], { trace }).backend);
    expect((await run('tracert -h 5 10.99.0.1')).slice(1, -3)).toEqual([
      'Tracing route to 10.99.0.1 over a maximum of 5 hops',
      '',
      '  1    <1 ms    <1 ms    <1 ms  192.168.1.1',
      '  2  192.168.1.1  reports: Destination net unreachable.',
    ]);
  });

  it('stops a trace on Ctrl+C mid-line', async () => {
    const trace: TraceProbe[] = [{ kind: 'timeout', hop: 1, probe: 1 }];
    const { backend, signals } = scripted([], { trace, hang: true });
    const { screen, type, idle } = await prompt(backend);
    type('tracert 10.99.0.1\r');
    await vi.waitFor(async () => expect((await screen()).at(-1)).toBe('  1     *'));
    type('\x03');
    await idle();
    expect(signals.map((signal) => signal.aborted)).toEqual([true]);
    expect((await screen()).slice(-4)).toEqual(['  1     *', '^C', '', PROMPT]);
  });

  it('clears the ARP cache, or one address in it, with arp -d', async () => {
    const { backend, cleared } = scripted([], { learned: 2 });
    const { run } = await prompt(backend);
    expect(await run('arp -d')).toEqual(['']);
    expect(await run('arp -d 192.168.1.1')).toEqual(['']);
    expect(cleared).toEqual([undefined, '192.168.1.1']);

    const { run: runEmpty } = await prompt(scripted([]).backend);
    expect(await runEmpty('arp -d 192.168.1.1')).toEqual([
      'The ARP entry deletion failed: Element not found.',
      '',
    ]);
  });

  it('recalls earlier lines with Up', async () => {
    const { run, type, screen, tty } = await prompt(scripted([]).backend);
    await run('help');
    await run('ipconfig');
    type(UP + UP);
    expect((await screen()).at(-1)).toBe(`${PROMPT}help`);
    expect(tty.history).toEqual(['help', 'ipconfig']);
  });

  it('prints ipconfig from the host config', async () => {
    const { run } = await prompt(scripted([]).backend);
    expect(await run('ipconfig')).toContain('   IPv4 Address. . . . . . . . . . . : 192.168.1.10');
  });

  it('clears the screen and the replay with cls', async () => {
    const { run, type, screen, idle, tty } = await prompt(scripted([]).backend);
    await run('help');
    type('cls\r');
    await idle();
    expect(await screen()).toEqual([PROMPT]);
    expect(tty.transcript).toBe(PROMPT);
  });

  it('prints what the backend cannot do', async () => {
    const failing: HostBackend = {
      ping: () => Promise.reject(new Error('PING: no engine')),
      traceroute: () => Promise.reject(new Error('TRACERT: no engine')),
      arpTable: () => Promise.reject(new Error('ARP: no engine')),
      clearArp: async () => 0,
    };
    const { run } = await prompt(failing);
    expect(await run('arp -a')).toEqual(['ARP: no engine', '']);
    expect(await run('ping 192.168.1.1')).toEqual([
      '',
      'Pinging 192.168.1.1 with 32 bytes of data:',
      '',
      'PING: no engine',
      '',
    ]);
  });

  it('says why a command did not parse', async () => {
    const { run } = await prompt(scripted([]).backend);
    expect(await run('show ip route')).toEqual(['Invalid Command.', '']);
  });
});
