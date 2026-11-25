import { afterEach, describe, expect, it, vi } from 'vitest';
import { consoleOn, router, switchDevice } from './testing';

describe('show history', () => {
  it('lists the EXEC lines typed so far, ending with itself', () => {
    const c = consoleOn(router());
    c.runAll(['enable', 'show version', 'configure terminal', 'hostname R1', 'end']);
    expect(c.run('show history')).toEqual([
      '  enable',
      '  show version',
      '  configure terminal',
      '  show history',
    ]);
  });

  it('lists config lines in config mode, kept apart from EXEC lines', () => {
    const c = consoleOn(switchDevice());
    c.runAll(['enable', 'configure terminal', 'hostname S1', 'interface f0/1']);
    expect(c.run('do show history')).toEqual([
      '  hostname S1',
      '  interface f0/1',
      '  do show history',
    ]);
  });

  it('keeps lines that failed, and the last 10 only', () => {
    const c = consoleOn(router());
    c.runAll(['enable', 'shw version', ...Array.from({ length: 9 }, () => 'show clock')]);
    const history = c.run('sh hist');
    expect(history).toHaveLength(10);
    expect(history.at(0)).toBe('  show clock');
    expect(history.at(-1)).toBe('  sh hist');

    const fresh = consoleOn(router());
    fresh.run('shw version');
    expect(fresh.run('show history')).toEqual(['  shw version', '  show history']);
  });

  it('never keeps a password', () => {
    const c = consoleOn(router());
    c.runAll(['enable', 'configure terminal', 'enable secret class', 'end']);
    c.runAll(['disable', 'enable', 'class']);
    expect(c.run('show history')).toEqual([
      '  enable',
      '  configure terminal',
      '  disable',
      '  enable',
      '  show history',
    ]);
  });

  it('filters through a pipe like any show command', () => {
    const c = consoleOn(router());
    c.runAll(['enable', 'show version', 'show clock']);
    expect(c.run('show history | include version')).toEqual([
      '  show version',
      '  show history | include version',
    ]);
  });
});

describe('show clock', () => {
  afterEach(() => void vi.useRealTimers());

  it('counts the simulated clock from the IOS boot date, marked not authoritative', () => {
    const c = consoleOn(router());
    const { query } = c.session.run(c.device, 'show clock');
    expect(query?.kind).toBe('clock');
    const render = query!.render as (elapsed: number) => readonly string[];
    expect(render(312_345)).toEqual(['*00:05:12.345 UTC Mon Mar 1 1993']);
    expect(render(26 * 3_600_000 + 1)).toEqual(['*02:00:00.001 UTC Tue Mar 2 1993']);
  });

  it('shows the wall clock in UTC when there is no simulation', () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 10, 25, 14, 3, 7, 9));
    expect(consoleOn(router()).run('show clock')).toEqual(['14:03:07.009 UTC Wed Nov 25 2026']);
  });
});
