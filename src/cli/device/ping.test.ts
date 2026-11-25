import { describe, expect, it } from 'vitest';
import type { PingEvent, PingListener, ProbeHandle } from '../../engine/api';
import { Ipv4Address } from '../../model';
import { openStream, type EngineStream, type StreamSource } from './query';
import { consoleOn, router, switchDevice } from './testing';

const TARGET = Ipv4Address.parse('10.0.0.2');
const HEAD =
  'Type escape sequence to abort.\n' +
  'Sending 5, 100-byte ICMP Echos to 10.0.0.2, timeout is 2 seconds:\n';
const PING: EngineStream = { kind: 'ping', target: TARGET, options: { count: 5, timeoutMs: 2000 } };

const reply = (seq: number, timeMs: number): PingEvent => ({
  kind: 'reply',
  seq,
  from: TARGET,
  bytes: 32,
  timeMs,
  ttl: 255,
});
const timeout = (seq: number): PingEvent => ({ kind: 'timeout', seq });
const unreachable = (seq: number): PingEvent => ({
  kind: 'unreachable',
  seq,
  from: Ipv4Address.parse('10.0.0.1'),
  code: 'host',
});
const summary = (received: number, rtt?: [number, number, number]): PingEvent => ({
  kind: 'summary',
  target: TARGET,
  sent: 5,
  received,
  ...(rtt && { rtt: { minMs: rtt[0], avgMs: rtt[1], maxMs: rtt[2] } }),
});

const HANDLE = 7 as ProbeHandle;

/** A simulation whose ping hands its listener to the test, which plays events through it. */
function scripted() {
  let listener: PingListener | undefined;
  const cancelled: ProbeHandle[] = [];
  const source: StreamSource = {
    ping: async (_target, _options, next) => {
      listener = next;
      return { ok: true, value: HANDLE };
    },
    traceroute: () => Promise.reject(new Error('not a traceroute')),
    cancel: async (handle) => void cancelled.push(handle),
  };
  return {
    source: async () => source,
    cancelled,
    play: (...events: PingEvent[]) => events.forEach((event) => listener!(event)),
  };
}

/** Opens the stream, collecting what it writes. `done` resolves with the whole text. */
function run(stream: EngineStream, source: () => Promise<StreamSource>) {
  const output = openStream(stream, source, ['% offline']);
  let text = '';
  const done = output.start((piece) => void (text += piece)).then(() => text);
  return { output, done, text: () => text };
}

const settle = () => new Promise((resolve) => setTimeout(resolve));

describe('ping output', () => {
  it('prints a ! per reply, streamed as each arrives, then the success rate', async () => {
    const sim = scripted();
    const ping = run(PING, sim.source);
    await settle();
    expect(ping.text()).toBe(HEAD);

    sim.play(reply(1, 1), reply(2, 4));
    expect(ping.text()).toBe(`${HEAD}!!`);

    sim.play(reply(3, 1), reply(4, 2), reply(5, 1), summary(5, [1, 1.8, 4]));
    expect(await ping.done).toBe(
      `${HEAD}!!!!!\nSuccess rate is 100 percent (5/5), round-trip min/avg/max = 1/2/4 ms\n`,
    );
  });

  it('prints a . per timeout and rounds the rate down', async () => {
    const sim = scripted();
    const ping = run(PING, sim.source);
    await settle();
    sim.play(timeout(1), reply(2, 3), timeout(3), reply(4, 5), reply(5, 4), summary(3, [3, 4, 5]));
    expect(await ping.done).toBe(
      `${HEAD}.!.!!\nSuccess rate is 60 percent (3/5), round-trip min/avg/max = 3/4/5 ms\n`,
    );
  });

  it('prints a U per unreachable, with no round-trip times', async () => {
    const sim = scripted();
    const ping = run(PING, sim.source);
    await settle();
    sim.play(...[1, 2, 3, 4, 5].map(unreachable), summary(0));
    expect(await ping.done).toBe(`${HEAD}UUUUU\nSuccess rate is 0 percent (0/5)\n`);
  });

  it('stops at an abort with the rate so far, cancels the ping, and drops later events', async () => {
    const sim = scripted();
    const ping = run(PING, sim.source);
    await settle();
    sim.play(reply(1, 2), timeout(2));
    ping.output.abort();
    const text = await ping.done;
    expect(text).toBe(
      `${HEAD}!.\nSuccess rate is 50 percent (1/2), round-trip min/avg/max = 2/2/2 ms\n`,
    );
    expect(sim.cancelled).toEqual([HANDLE]);

    sim.play(summary(2, [2, 2, 2]));
    expect(ping.text()).toBe(text);
  });

  it('counts the request in flight when aborted before any settles', async () => {
    const sim = scripted();
    const ping = run(PING, sim.source);
    await settle();
    ping.output.abort();
    expect(await ping.done).toBe(`${HEAD}\nSuccess rate is 0 percent (0/1)\n`);
  });

  it('cancels a ping aborted while the simulation was still starting it', async () => {
    let started!: () => void;
    const cancelled: ProbeHandle[] = [];
    const source: StreamSource = {
      ping: () => new Promise((resolve) => (started = () => resolve({ ok: true, value: HANDLE }))),
      traceroute: () => Promise.reject(new Error('not a traceroute')),
      cancel: async (handle) => void cancelled.push(handle),
    };
    const ping = run(PING, async () => source);
    await settle();
    ping.output.abort();
    await ping.done;
    expect(cancelled).toEqual([]);

    started();
    await settle();
    expect(cancelled).toEqual([HANDLE]);
  });

  it('does not cancel a ping that finished', async () => {
    const sim = scripted();
    const ping = run(PING, sim.source);
    await settle();
    sim.play(...[1, 2, 3, 4, 5].map(unreachable), summary(0));
    await ping.done;
    ping.output.abort();
    expect(sim.cancelled).toEqual([]);
  });

  it('prints the offline output when the simulation cannot be reached', async () => {
    const ping = run(PING, () => Promise.reject(new Error('no worker')));
    expect(await ping.done).toBe('% offline\n');
  });

  it('says why when the device cannot ping', async () => {
    const source: StreamSource = {
      ping: async () => ({ ok: false, error: 'powered-off' }),
      traceroute: () => Promise.reject(new Error('not a traceroute')),
      cancel: async () => {},
    };
    const ping = run(PING, async () => source);
    expect(await ping.done).toBe(`${HEAD}% The device is powered off.\n`);
  });
});

describe('the ping command', () => {
  it('streams 5 echoes with a 2 second timeout from user and privileged EXEC', () => {
    const c = consoleOn(router());
    const user = c.session.run(c.device, 'ping 10.0.0.2');
    expect(user.stream).toEqual(PING);
    expect(user.output).toEqual([
      '% The simulation is not running, so there is nothing to ping through.',
    ]);
    c.run('enable');
    expect(c.session.run(c.device, 'ping 10.0.0.2').stream).toEqual(PING);
  });

  it('takes repeat and timeout in either order, on a switch too', () => {
    const c = consoleOn(switchDevice());
    const expected = { ...PING, options: { count: 3, timeoutMs: 1000 } };
    expect(c.session.run(c.device, 'ping 10.0.0.2 repeat 3 timeout 1').stream).toEqual(expected);
    expect(c.session.run(c.device, 'ping 10.0.0.2 timeout 1 repeat 3').stream).toEqual(expected);
    expect(c.session.run(c.device, 'ping 10.0.0.2 repeat 2').stream?.options).toEqual({
      count: 2,
      timeoutMs: 2000,
    });
  });

  it('is an EXEC command only', () => {
    const c = consoleOn(router());
    c.runAll(['enable', 'configure terminal']);
    expect(c.session.run(c.device, 'ping 10.0.0.2').stream).toBeUndefined();
    expect(c.session.run(c.device, 'do ping 10.0.0.2').stream).toEqual(PING);
  });

  it('lists its options with ?', () => {
    const c = consoleOn(router());
    expect(c.session.help(c.device, 'ping 10.0.0.2 ')).toEqual([
      '  repeat   specify repeat count',
      '  timeout  specify timeout interval',
      '  <cr>',
    ]);
  });
});
