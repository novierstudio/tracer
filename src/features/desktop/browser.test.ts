import { describe, expect, it } from 'vitest';
import { Ipv4Address } from '@/model';
import { describeFailure, formatUrl, loadingStatus, parseUrl } from './browser';

const target = (text: string) => {
  const result = parseUrl(text);
  return result.ok ? result.value : { error: result.error };
};

describe('parseUrl', () => {
  it('reads a bare name, a full URL, and an address with a port and path', () => {
    expect(target('www.lab.local')).toEqual({ host: 'www.lab.local', port: 80, path: '/' });
    expect(target('  HTTP://WWW.Lab.Local/  ')).toEqual({
      host: 'www.lab.local',
      port: 80,
      path: '/',
    });
    expect(target('http://192.168.1.20:8080/index.html')).toEqual({
      host: '192.168.1.20',
      port: 8080,
      path: '/index.html',
    });
    expect(target('www.lab.local:8080/a?b=1#top')).toEqual({
      host: 'www.lab.local',
      port: 8080,
      path: '/a?b=1',
    });
  });

  it('refuses https and other schemes with a reason', () => {
    expect(target('https://www.lab.local')).toEqual({
      error: 'Tracer servers speak plain HTTP. Try the address with http:// instead.',
    });
    expect(target('javascript:alert(1)')).toEqual({
      error: 'The browser opens http:// addresses only, not javascript:.',
    });
    expect(target('ftp://www.lab.local')).toMatchObject({ error: expect.stringContaining('ftp:') });
  });

  it('refuses what is not a web address', () => {
    expect(target('   ')).toEqual({ error: 'Type an address, such as www.lab.local.' });
    expect(target('www.lab.local:99999')).toMatchObject({ error: expect.any(String) });
    expect(target('bad_host')).toMatchObject({ error: expect.any(String) });
    expect(target('http://user@www.lab.local')).toMatchObject({ error: expect.any(String) });
    expect(target('192.168.1.300')).toMatchObject({ error: expect.any(String) });
  });

  it('writes a target back as the address bar shows it', () => {
    expect(formatUrl({ host: 'www.lab.local', port: 80, path: '/' })).toBe('http://www.lab.local/');
    expect(formatUrl({ host: '192.168.1.20', port: 8080, path: '/index.html' })).toBe(
      'http://192.168.1.20:8080/index.html',
    );
  });
});

describe('the status and failure wording', () => {
  const SERVER = Ipv4Address.parse('192.168.1.20');
  const TARGET = { host: 'www.lab.local', port: 80, path: '/' };

  it('follows a load step by step', () => {
    expect(loadingStatus(undefined, TARGET)).toBe('Opening http://www.lab.local/…');
    expect(
      loadingStatus({ kind: 'resolving', name: 'www.lab.local', server: SERVER }, TARGET),
    ).toBe('Resolving www.lab.local with DNS server 192.168.1.20…');
    expect(loadingStatus({ kind: 'connecting', address: SERVER, port: 8080 }, TARGET)).toBe(
      'Connecting to 192.168.1.20:8080…',
    );
  });

  it('names each failure', () => {
    expect(describeFailure({ kind: 'no-dns-server' }).title).toBe('No DNS server');
    expect(
      describeFailure({ kind: 'name-not-found', name: 'www.x.local', server: SERVER }),
    ).toEqual({
      title: 'Server not found',
      detail: expect.stringContaining('no record for www.x.local'),
    });
    expect(describeFailure({ kind: 'dns-timeout', server: SERVER }).title).toBe(
      'DNS server not responding',
    );
    expect(describeFailure({ kind: 'refused', address: SERVER, port: 80 }).title).toBe(
      'Connection refused',
    );
    expect(describeFailure({ kind: 'timeout', address: SERVER }).title).toBe(
      'Connection timed out',
    );
    expect(describeFailure({ kind: 'reset', address: SERVER }).title).toBe('Connection reset');
    expect(describeFailure({ kind: 'cancelled' }).title).toBe('Page load stopped');
  });
});
