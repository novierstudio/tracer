import { describe, expect, it } from 'vitest';
import { HELP, parseCommand, PING_USAGE } from './commands';

const parsed = (line: string) => {
  const result = parseCommand(line);
  return result.ok ? result.value : { error: result.error };
};

describe('parseCommand', () => {
  it('reads a blank line as nothing to run', () => {
    expect(parsed('   ')).toEqual({ kind: 'empty' });
  });

  it('pings four times by default', () => {
    expect(parsed('ping 10.0.0.2')).toEqual({ kind: 'ping', target: '10.0.0.2', count: 4 });
  });

  it('takes -n and /n before or after the target, in any case', () => {
    expect(parsed('ping 10.0.0.2 -n 2')).toMatchObject({ count: 2 });
    expect(parsed('PING -N 7 10.0.0.2')).toMatchObject({ count: 7, target: '10.0.0.2' });
    expect(parsed('ping /n 1 10.0.0.2')).toMatchObject({ count: 1 });
  });

  it('has no -t, since the engine cannot stop a ping yet', () => {
    expect(parsed('ping -t 10.0.0.2')).toEqual({ error: ['Bad option -t.', ...PING_USAGE] });
  });

  it('rejects bad ping arguments with the Windows wording', () => {
    expect(parsed('ping')).toEqual({ error: PING_USAGE });
    expect(parsed('ping 10.0.0.2 -n')).toEqual({
      error: ['Value must be supplied for option -n.'],
    });
    expect(parsed('ping 10.0.0.2 -n 0')).toEqual({
      error: ['Bad value for option -n, valid range is from 1 to 4294967295.'],
    });
    expect(parsed('ping 10.0.0.2 -n two')).toMatchObject({
      error: ['Bad value for option -n, valid range is from 1 to 4294967295.'],
    });
    expect(parsed('ping 10.0.0.256')).toEqual({
      error: ['Ping request could not find host 10.0.0.256. Please check the name and try again.'],
    });
    expect(parsed('ping server.lan')).toMatchObject({
      error: ['Ping request could not find host server.lan. Please check the name and try again.'],
    });
    expect(parsed('ping 10.0.0.2 10.0.0.3')).toEqual({ error: ['Bad parameter 10.0.0.3.'] });
    expect(parsed('ping -x 10.0.0.2')).toEqual({ error: ['Bad option -x.', ...PING_USAGE] });
  });

  it('reads ipconfig and ipconfig /all', () => {
    expect(parsed('ipconfig')).toEqual({ kind: 'ipconfig', all: false });
    expect(parsed('ipconfig /all')).toEqual({ kind: 'ipconfig', all: true });
    expect(parsed('IPCONFIG -ALL')).toEqual({ kind: 'ipconfig', all: true });
    expect(parsed('ipconfig /renew')).toMatchObject({
      error: expect.arrayContaining(['Error: unrecognized or incomplete command line.']),
    });
  });

  it('reads arp -a and arp -d', () => {
    expect(parsed('arp -a')).toEqual({ kind: 'arp-show' });
    expect(parsed('arp -d')).toEqual({ kind: 'arp-clear' });
    expect(parsed('arp -d *')).toEqual({ kind: 'arp-clear' });
    expect(parsed('arp')).toMatchObject({ error: expect.arrayContaining(['ARP -a']) });
  });

  it('reads help and cls, and refuses anything else', () => {
    expect(parsed('help')).toEqual({ kind: 'help' });
    expect(parsed('CLS')).toEqual({ kind: 'cls' });
    expect(parsed('enable')).toEqual({ error: ['Invalid Command.'] });
    expect(HELP.join('\n')).toContain('ping <ip>');
  });
});
