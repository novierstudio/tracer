import { describe, expect, it } from 'vitest';
import type { ProbeHandle, TraceEvent, TraceListener } from '../../engine/api';
import { Ipv4Address } from '../../model';
import { TRACE_OPTIONS } from './exec';
import { openStream, type EngineStream, type StreamSource } from './query';
import { consoleOn, router, switchDevice } from './testing';

const TARGET = Ipv4Address.parse('192.168.2.10');
const TRACE: EngineStream = { kind: 'traceroute', target: TARGET, options: TRACE_OPTIONS };
const HEAD = 'Type escape sequence to abort.\nTracing the route to 192.168.2.10\n\n';
const HANDLE = 3 as ProbeHandle;

const ip = (text: string) => Ipv4Address.parse(text);
const expired = (hop: number, probe: number, from: string, timeMs: number): TraceEvent => ({
  kind: 'ttl-expired',
  hop,
  probe,
  from: ip(from),
  timeMs,
});
const reply = (hop: number, probe: number, timeMs: number): TraceEvent => ({
  kind: 'reply',
  hop,
  probe,
  from: TARGET,
  timeMs,
  ttl: 128,
});
const timeout = (hop: number, probe: number): TraceEvent => ({ kind: 'timeout', hop, probe });
const DONE: TraceEvent = { kind: 'done' };

/** A simulation whose traceroute hands its listener to the test, which plays events through it. */
function scripted() {
  let listener: TraceListener | undefined;
  const cancelled: ProbeHandle[] = [];
  const source: StreamSource = {
    ping: () => Promise.reject(new Error('not a ping')),
    traceroute: async (_target, _options, next) => {
      listener = next;
      return { ok: true, value: HANDLE };
    },
    cancel: async (handle) => void cancelled.push(handle),
  };
  return {
    source: async () => source,
    cancelled,
    play: (...events: TraceEvent[]) => events.forEach((event) => listener!(event)),
  };
}

function run(source: () => Promise<StreamSource>) {
  const output = openStream(TRACE, source, ['% offline']);
  let text = '';
  const done = output.start((piece) => void (text += piece)).then(() => text);
  return { output, done, text: () => text };
}

const settle = () => new Promise((resolve) => setTimeout(resolve));

describe('traceroute output', () => {
  it('prints a line per hop as its probes settle, in IOS format', async () => {
    const sim = scripted();
    const trace = run(sim.source);
    await settle();
    expect(trace.text()).toBe(HEAD);

    sim.play(expired(1, 1, '10.0.12.2', 4));
    expect(trace.text()).toBe(`${HEAD}  1 10.0.12.2 4 msec`);

    sim.play(expired(1, 2, '10.0.12.2', 0), expired(1, 3, '10.0.12.2', 1.4));
    sim.play(reply(2, 1, 8), reply(2, 2, 4), reply(2, 3, 4), DONE);
    expect(await trace.done).toBe(
      `${HEAD}` +
        '  1 10.0.12.2 4 msec 0 msec 1 msec\n' +
        '  2 192.168.2.10 8 msec 4 msec 4 msec\n',
    );
  });

  it('prints * for a probe with no answer, and the address again when the responder changes', async () => {
    const sim = scripted();
    const trace = run(sim.source);
    await settle();
    sim.play(timeout(1, 1), timeout(1, 2), timeout(1, 3));
    sim.play(timeout(2, 1), expired(2, 2, '10.0.0.1', 4), expired(2, 3, '10.0.0.5', 8), DONE);
    expect(await trace.done).toBe(`${HEAD}  1 *  *  * \n  2 *  10.0.0.1 4 msec 10.0.0.5 8 msec\n`);
  });

  it('prints !N for a router with no route to the target', async () => {
    const sim = scripted();
    const trace = run(sim.source);
    await settle();
    sim.play({
      kind: 'unreachable',
      hop: 1,
      probe: 1,
      from: ip('192.168.1.1'),
      code: 'network',
      timeMs: 4,
    });
    sim.play(DONE);
    expect(await trace.done).toBe(`${HEAD}  1 192.168.1.1 !N \n`);
  });

  it('ends the open line at an abort, cancels the traceroute and drops later events', async () => {
    const sim = scripted();
    const trace = run(sim.source);
    await settle();
    sim.play(expired(1, 1, '10.0.12.2', 4), timeout(1, 2));
    trace.output.abort();
    const text = await trace.done;
    expect(text).toBe(`${HEAD}  1 10.0.12.2 4 msec * \n`);
    expect(sim.cancelled).toEqual([HANDLE]);

    sim.play(timeout(1, 3), DONE);
    expect(trace.text()).toBe(text);
  });
});

describe('the traceroute command', () => {
  it('streams a 30 hop trace with 3 probes of 3 seconds from user and privileged EXEC', () => {
    const c = consoleOn(router());
    const user = c.session.run(c.device, 'traceroute 192.168.2.10');
    expect(user.stream).toEqual(TRACE);
    expect(user.output).toEqual([
      '% The simulation is not running, so there is nothing to trace through.',
    ]);
    c.run('enable');
    expect(c.session.run(c.device, 'traceroute 192.168.2.10').stream).toEqual(TRACE);
  });

  it('runs on a switch, and from config mode only through do', () => {
    const c = consoleOn(switchDevice());
    c.runAll(['enable', 'configure terminal']);
    expect(c.session.run(c.device, 'traceroute 192.168.2.10').stream).toBeUndefined();
    expect(c.session.run(c.device, 'do traceroute 192.168.2.10').stream).toEqual(TRACE);
  });

  it('completes from tr and asks for an address, IPv6 on a router only', () => {
    const c = consoleOn(router());
    expect(c.session.help(c.device, 'tr')).toEqual(['traceroute']);
    expect(c.session.help(c.device, 'traceroute ')).toEqual([
      '  A.B.C.D     Trace route to destination address',
      '  X:X:X:X::X  Trace route to destination address',
      '  ipv6        IPv6 trace',
    ]);
    const s = consoleOn(switchDevice());
    expect(s.session.help(s.device, 'traceroute ')).toEqual([
      '  A.B.C.D  Trace route to destination address',
    ]);
  });
});
