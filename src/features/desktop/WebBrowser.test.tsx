import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DeviceId, Ipv4Address } from '@/model';
import type { BrowseTarget, FetchEvent, HostBackend } from './backend';
import { WebBrowser } from './WebBrowser';

const SERVER = Ipv4Address.parse('192.168.1.20');
let next = 0;

/** A backend whose page loads the test drives by hand, one event at a time. */
function manual() {
  const loads: { target: BrowseTarget; emit: (event: FetchEvent) => void; signal: AbortSignal }[] =
    [];
  const browse: HostBackend['browse'] = (_device, target, onEvent, signal) => {
    loads.push({ target, emit: (event) => act(() => onEvent(event)), signal });
    return new Promise<void>(() => {});
  };
  return { backend: { browse } as Pick<HostBackend, 'browse'> as HostBackend, loads };
}

function open(backend: HostBackend, device = DeviceId.parse(`dev_PC${next++}`)) {
  const view = render(<WebBrowser device={device} backend={backend} />);
  const visit = (url: string) => {
    fireEvent.change(screen.getByRole('textbox', { name: 'URL' }), { target: { value: url } });
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));
  };
  return { ...view, device, visit };
}

const response = (status: number, reason: string, body: string): FetchEvent => ({
  kind: 'response',
  address: SERVER,
  response: { kind: 'http', type: 'response', status, reason, contentType: 'text/html', body },
});

describe('the Web Browser', () => {
  it('shows each step of the load, then the page in a sandboxed frame', () => {
    const { backend, loads } = manual();
    const { visit } = open(backend);
    visit('WWW.lab.local');
    expect(loads[0]?.target).toEqual({ host: 'www.lab.local', port: 80, path: '/' });
    expect(screen.getByRole('textbox', { name: 'URL' })).toHaveValue('http://www.lab.local/');
    const status = screen.getByRole('status', { name: 'Page status' });
    expect(status).toHaveTextContent('Opening http://www.lab.local/…');

    loads[0]!.emit({ kind: 'resolving', name: 'www.lab.local', server: SERVER });
    expect(status).toHaveTextContent('Resolving www.lab.local with DNS server 192.168.1.20…');
    loads[0]!.emit({ kind: 'connecting', address: SERVER, port: 80 });
    expect(status).toHaveTextContent('Connecting to 192.168.1.20…');
    loads[0]!.emit(response(200, 'OK', '<h1 onclick="x()">It works!</h1><script>x()</script>'));

    expect(status).toHaveTextContent('HTTP 200 OK from 192.168.1.20');
    const frame = screen.getByTitle('Page');
    expect(frame.tagName).toBe('IFRAME');
    expect(frame.getAttribute('sandbox')).toBe('');
    const srcdoc = frame.getAttribute('srcdoc') ?? '';
    expect(srcdoc).toContain('<h1>It works!</h1>');
    expect(srcdoc).not.toContain('script');
    expect(srcdoc).toContain('Content-Security-Policy');
  });

  it('renders the body of a 404 like a browser does', () => {
    const { backend, loads } = manual();
    open(backend).visit('http://192.168.1.20:8080/missing.html');
    expect(loads[0]?.target).toEqual({ host: '192.168.1.20', port: 8080, path: '/missing.html' });
    loads[0]!.emit(response(404, 'Not Found', '<h1>404 Not Found</h1>'));
    expect(screen.getByRole('status', { name: 'Page status' })).toHaveTextContent(
      'HTTP 404 Not Found',
    );
    expect(screen.getByTitle('Page').getAttribute('srcdoc')).toContain('404 Not Found');
  });

  it('explains a failed load, and tries again', () => {
    const { backend, loads } = manual();
    open(backend).visit('www.x.local');
    loads[0]!.emit({
      kind: 'failed',
      failure: { kind: 'name-not-found', name: 'www.x.local', server: SERVER },
    });
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Server not found');
    expect(alert).toHaveTextContent('no record for www.x.local');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(loads).toHaveLength(2);
  });

  it('refuses https without loading anything', () => {
    const { backend, loads } = manual();
    open(backend).visit('https://www.lab.local');
    expect(screen.getByRole('alert')).toHaveTextContent('Tracer servers speak plain HTTP');
    expect(loads).toHaveLength(0);
  });

  it('says why a device cannot browse', async () => {
    const backend = {
      browse: () =>
        Promise.reject(new Error('The page could not load: the device is powered off.')),
    } as Pick<HostBackend, 'browse'> as HostBackend;
    open(backend).visit('www.lab.local');
    expect(await screen.findByRole('alert')).toHaveTextContent('the device is powered off.');
  });

  it('drops the old load when a new one starts, and when it closes', () => {
    const { backend, loads } = manual();
    const { visit, unmount } = open(backend);
    visit('www.lab.local');
    visit('192.168.1.20');
    expect(loads[0]!.signal.aborted).toBe(true);
    unmount();
    expect(loads[1]!.signal.aborted).toBe(true);
  });

  it('comes back to the last page it showed on that host', () => {
    const { backend, loads } = manual();
    const { device, unmount } = open(backend);
    fireEvent.change(screen.getByRole('textbox', { name: 'URL' }), {
      target: { value: 'www.lab.local' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    loads[0]!.emit(response(200, 'OK', '<p>remembered</p>'));
    unmount();
    open(backend, device);
    expect(screen.getByRole('textbox', { name: 'URL' })).toHaveValue('http://www.lab.local/');
    expect(screen.getByTitle('Page').getAttribute('srcdoc')).toContain('remembered');
  });
});
