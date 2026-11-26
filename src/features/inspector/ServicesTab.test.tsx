import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_INDEX_HTML, serverServices, type DeviceId } from '@/model';
import { editorStore } from '@/model/store';
import { TooltipProvider } from '@/ui/tooltip';
import { InspectorPanel } from './InspectorPanel';
import { buildOffice } from './testing';

vi.mock('@/features/terminal/Terminal', () => ({
  DeviceTerminal: ({ device }: { device: DeviceId }) => (
    <div role="log" aria-label={`Console of ${device}`} />
  ),
}));

let lab: ReturnType<typeof buildOffice>;

beforeEach(() => {
  lab = buildOffice();
  act(() => editorStore.getState().load(lab.topology));
});

const editor = () => editorStore.getState();

/** Server1's services as the store has them now. */
function services() {
  const device = editor().topology.devices[lab.server.id];
  if (device?.kind !== 'server') throw new Error('Server1 is not a server');
  return serverServices(device.config);
}

function openServices() {
  render(
    <TooltipProvider>
      <InspectorPanel />
    </TooltipProvider>,
  );
  act(() => editor().select({ devices: [lab.server.id], links: [] }));
  fireEvent.mouseDown(screen.getByRole('tab', { name: 'Services' }), { button: 0 });
}

const field = (name: string) => screen.getByRole('textbox', { name });

function addRecord(name: string, address: string) {
  fireEvent.change(field('Record name'), { target: { value: name } });
  fireEvent.change(field('Record address'), { target: { value: address } });
  fireEvent.click(screen.getByRole('button', { name: 'Add record' }));
}

describe('a server’s Services tab', () => {
  it('appears for a server only', () => {
    render(
      <TooltipProvider>
        <InspectorPanel />
      </TooltipProvider>,
    );
    act(() => editor().select({ devices: [lab.pc.id], links: [] }));
    expect(screen.queryByRole('tab', { name: 'Services' })).toBeNull();
    act(() => editor().select({ devices: [lab.server.id], links: [] }));
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Services' }), { button: 0 });
    expect(screen.getByRole('switch', { name: 'DNS service' })).toBeVisible();
    // A PC has no Services tab, so the tab kept from the server shows its Config.
    act(() => editor().select({ devices: [lab.pc.id], links: [] }));
    expect(screen.getByRole('form', { name: 'IP configuration' })).toBeVisible();
  });

  it('turns DNS on, adds and removes A records, as undoable config', () => {
    openServices();
    const dns = screen.getByRole('switch', { name: 'DNS service' });
    expect(dns).not.toBeChecked();
    fireEvent.click(dns);
    expect(services().dns.enabled).toBe(true);

    addRecord(' WWW.Lab.Local ', '192.168.1.20');
    expect(services().dns.records).toEqual([{ name: 'www.lab.local', address: '192.168.1.20' }]);
    const table = screen.getByRole('table', { name: 'DNS records' });
    expect(within(table).getByText('www.lab.local')).toBeVisible();
    expect(field('Record name')).toHaveValue('');

    fireEvent.click(screen.getByRole('button', { name: 'Remove www.lab.local' }));
    expect(services().dns.records).toEqual([]);
    act(() => editor().undo());
    expect(services().dns.records).toHaveLength(1);
  });

  it('refuses a bad name, a bad address or a second record for a name', () => {
    openServices();
    addRecord('bad_name', '192.168.1.20');
    expect(screen.getByRole('alert')).toHaveTextContent('letters, digits and hyphens');
    expect(field('Record name')).toHaveAttribute('aria-invalid', 'true');
    addRecord('www.lab.local', '192.168.1.300');
    expect(screen.getByRole('alert')).toBeVisible();
    expect(field('Record address')).toHaveAttribute('aria-invalid', 'true');
    expect(services().dns.records).toEqual([]);

    addRecord('www.lab.local', '192.168.1.20');
    addRecord('www.lab.local', '192.168.1.21');
    expect(screen.getByRole('alert')).toHaveTextContent('www.lab.local already has a record');
    expect(services().dns.records).toHaveLength(1);
  });

  it('turns HTTP off, and saves index.html on blur or Save, or reverts it', () => {
    openServices();
    const http = screen.getByRole('switch', { name: 'HTTP service' });
    expect(http).toBeChecked();
    fireEvent.click(http);
    expect(services().http.enabled).toBe(false);

    const page = field('index.html');
    expect(page).toHaveValue(DEFAULT_INDEX_HTML);
    fireEvent.change(page, { target: { value: '<h1>Lab</h1>' } });
    fireEvent.blur(page);
    expect(services().http.indexHtml).toBe('<h1>Lab</h1>');

    fireEvent.change(page, { target: { value: '<h1>Saved</h1>' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(services().http.indexHtml).toBe('<h1>Saved</h1>');

    fireEvent.change(page, { target: { value: '<h1>Draft</h1>' } });
    fireEvent.click(screen.getByRole('button', { name: 'Revert' }));
    expect(page).toHaveValue('<h1>Saved</h1>');
    expect(services().http.indexHtml).toBe('<h1>Saved</h1>');
  });
});
