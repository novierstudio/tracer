import { describe, expect, it } from 'vitest';
import type { InterfaceId } from '../model';
import { endMode, exitMode, GLOBAL_CONFIG, PRIV_EXEC, prompt, USER_EXEC, type Mode } from './modes';

const g00 = 'GigabitEthernet0/0' as InterfaceId;
const g01 = 'GigabitEthernet0/1' as InterfaceId;
const IF: Mode = { kind: 'interface-config', interfaces: [g00] };
const IF_RANGE: Mode = { kind: 'interface-config', interfaces: [g00, g01] };
const LINE: Mode = { kind: 'line-config', line: 'console 0' };
const ROUTER: Mode = { kind: 'router-config', protocol: 'rip' };

describe('modes', () => {
  it.each<[Mode, string]>([
    [USER_EXEC, 'R1>'],
    [PRIV_EXEC, 'R1#'],
    [GLOBAL_CONFIG, 'R1(config)#'],
    [IF, 'R1(config-if)#'],
    [IF_RANGE, 'R1(config-if-range)#'],
    [LINE, 'R1(config-line)#'],
    [ROUTER, 'R1(config-router)#'],
  ])('prompt for %o is %s', (mode, expected) => {
    expect(prompt('R1', mode)).toBe(expected);
  });

  it.each<[Mode, Mode]>([
    [USER_EXEC, USER_EXEC],
    [PRIV_EXEC, USER_EXEC],
    [GLOBAL_CONFIG, PRIV_EXEC],
    [IF, GLOBAL_CONFIG],
    [LINE, GLOBAL_CONFIG],
    [ROUTER, GLOBAL_CONFIG],
  ])('exit from %o goes to %o', (from, to) => {
    expect(exitMode(from)).toEqual(to);
  });

  it.each<[Mode, Mode]>([
    [USER_EXEC, USER_EXEC],
    [PRIV_EXEC, PRIV_EXEC],
    [GLOBAL_CONFIG, PRIV_EXEC],
    [IF, PRIV_EXEC],
    [LINE, PRIV_EXEC],
    [ROUTER, PRIV_EXEC],
  ])('end or Ctrl+Z from %o goes to %o', (from, to) => {
    expect(endMode(from)).toEqual(to);
  });
});
