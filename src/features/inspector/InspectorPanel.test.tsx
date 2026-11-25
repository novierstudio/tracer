import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import type { DeviceId, LinkId } from '@/model';
import { editorStore } from '@/model/store';
import { TooltipProvider } from '@/ui/tooltip';
import { InspectorPanel } from './InspectorPanel';
import { buildOffice } from './testing';

let lab: ReturnType<typeof buildOffice>;

beforeEach(() => {
  lab = buildOffice();
  act(() => editorStore.getState().load(lab.topology));
});

const editor = () => editorStore.getState();
const select = (devices: DeviceId[], links: LinkId[] = []) =>
  act(() => editor().select({ devices, links }));
const deviceIn = (id: DeviceId) => editor().topology.devices[id];
const hostnameOf = (id: DeviceId) => deviceIn(id)?.config.hostname;

function renderPanel() {
  render(
    <TooltipProvider>
      <InspectorPanel />
    </TooltipProvider>,
  );
  return screen.getByRole('complementary', { name: 'Inspector' });
}

function openTab(name: string) {
  fireEvent.mouseDown(screen.getByRole('tab', { name }), { button: 0 });
}

const hostnameInput = () => screen.getByRole('textbox', { name: 'Hostname' });

describe('InspectorPanel', () => {
  it('shows the empty state with nothing selected', () => {
    renderPanel();
    expect(screen.getByText('Nothing selected')).toBeVisible();
    expect(screen.queryByRole('tablist')).toBeNull();
  });

  it('shows one router: header, tabs and its interfaces', () => {
    renderPanel();
    select([lab.r1.id]);

    expect(hostnameInput()).toHaveValue('R1');
    expect(screen.getByText('Branch Router', { selector: 'header *' })).toBeVisible();
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'Overview',
      'Interfaces',
      'Config',
      'CLI',
    ]);
    expect(screen.getByText('2 of 4 connected')).toBeVisible();

    openTab('Interfaces');
    const list = screen.getByRole('list', { name: 'Interfaces' });
    const row = (port: string) => within(list).getByRole('listitem', { name: port });
    expect(row('Gi0/0')).toHaveTextContent('192.168.1.1/24');
    expect(row('Gi0/0')).toHaveTextContent('SW1Gi0/1');
    expect(row('Gi0/1')).toHaveTextContent('free');
    expect(within(row('Gi0/1')).getByRole('switch', { name: 'Gi0/1 enabled' })).not.toBeChecked();

    openTab('CLI');
    expect(screen.getByText('CLI comes with device sessions')).toBeVisible();
  });

  it('turns a device off and on from the header, undoably', () => {
    renderPanel();
    select([lab.r1.id]);
    const power = screen.getByRole('switch', { name: 'Power' });
    expect(power).toBeChecked();

    fireEvent.click(power);
    expect(deviceIn(lab.r1.id)?.powered).toBe(false);
    expect(power).not.toBeChecked();

    act(() => editor().undo());
    expect(deviceIn(lab.r1.id)?.powered).toBe(true);
    expect(power).toBeChecked();
  });

  it('labels the console tab Desktop for an end host', () => {
    renderPanel();
    select([lab.pc.id]);
    expect(screen.getByRole('tab', { name: 'Desktop' })).toBeVisible();
  });

  it('renames on Enter, and undo restores the old name in the field', () => {
    renderPanel();
    select([lab.r1.id]);

    fireEvent.change(hostnameInput(), { target: { value: 'Core-1' } });
    fireEvent.keyDown(hostnameInput(), { key: 'Enter' });
    expect(hostnameOf(lab.r1.id)).toBe('Core-1');
    expect(hostnameInput()).toHaveValue('Core-1');

    act(() => editor().undo());
    expect(hostnameOf(lab.r1.id)).toBe('R1');
    expect(hostnameInput()).toHaveValue('R1');

    act(() => editor().redo());
    expect(hostnameInput()).toHaveValue('Core-1');
  });

  it('renames on blur', () => {
    renderPanel();
    select([lab.pc.id]);
    fireEvent.change(hostnameInput(), { target: { value: 'Reception' } });
    fireEvent.blur(hostnameInput());
    expect(hostnameOf(lab.pc.id)).toBe('Reception');
  });

  it('keeps an invalid hostname out of the store and shows the IOS rule', () => {
    renderPanel();
    select([lab.r1.id]);
    const before = editorStore.temporal.getState().pastStates.length;

    fireEvent.change(hostnameInput(), { target: { value: '1st floor' } });
    fireEvent.keyDown(hostnameInput(), { key: 'Enter' });

    expect(screen.getByRole('alert')).toHaveTextContent(/must start with a letter/);
    expect(hostnameInput()).toHaveAttribute('aria-invalid', 'true');
    expect(hostnameOf(lab.r1.id)).toBe('R1');
    expect(editorStore.temporal.getState().pastStates).toHaveLength(before);

    fireEvent.keyDown(hostnameInput(), { key: 'Escape' });
    expect(hostnameInput()).toHaveValue('R1');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows a link with both endpoints and deletes it', () => {
    const panel = renderPanel();
    select([], [lab.wan.id]);

    expect(within(panel).getByRole('heading', { name: 'Serial DCE/DTE' })).toBeVisible();
    const endA = screen.getByRole('button', { name: 'End A: R1 Serial0/0/0' });
    const endB = screen.getByRole('button', { name: 'End B: R2 Serial0/0/0' });
    expect(endA).toHaveTextContent('DCE');
    expect(endB).toHaveTextContent('DTE');
    // R2's serial port is still shut down, so the link cannot come up.
    expect(endB).toHaveTextContent('shut down');
    expect(within(panel).getByText('Link down')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Delete link' }));
    expect(editor().topology.links[lab.wan.id]).toBeUndefined();
    expect(screen.getByText('Nothing selected')).toBeVisible();
  });

  it('switches a copper link between straight-through and crossover, undoably', () => {
    renderPanel();
    select([], [lab.uplink.id]);
    const picker = screen.getByRole('radiogroup', { name: 'Cable type' });
    expect(
      within(picker)
        .getAllByRole('radio')
        .map((option) => option.textContent),
    ).toEqual(['Straight-through', 'Crossover']);

    fireEvent.click(within(picker).getByRole('radio', { name: 'Crossover' }));
    expect(editor().topology.links[lab.uplink.id]).toEqual({ ...lab.uplink, cable: 'crossover' });
    expect(screen.getByRole('heading', { name: 'Copper crossover' })).toBeVisible();

    act(() => editor().undo());
    expect(within(picker).getByRole('radio', { name: 'Straight-through' })).toBeChecked();
  });

  it('moves the DCE end of a serial link', () => {
    renderPanel();
    select([], [lab.wan.id]);
    expect(screen.queryByRole('radiogroup', { name: 'Cable type' })).toBeNull();

    fireEvent.click(screen.getByRole('radio', { name: 'R2' }));
    expect(editor().topology.links[lab.wan.id]).toMatchObject({ cable: 'serial', dce: 'b' });
    expect(screen.getByRole('button', { name: 'End B: R2 Serial0/0/0' })).toHaveTextContent('DCE');
  });

  it('jumps from a link endpoint to its device', () => {
    renderPanel();
    select([], [lab.uplink.id]);
    fireEvent.click(screen.getByRole('button', { name: 'End B: SW1 GigabitEthernet0/1' }));
    expect(hostnameInput()).toHaveValue('SW1');
  });

  it('summarises a multi-selection and deletes it as one undo step', () => {
    renderPanel();
    select([lab.r1.id, lab.pc.id], [lab.wan.id]);

    expect(screen.getByRole('heading', { name: '3 items selected' })).toBeVisible();
    expect(screen.getByText('1 router, 1 PC and 1 link')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Delete 3 items' }));
    expect(deviceIn(lab.r1.id)).toBeUndefined();
    expect(deviceIn(lab.pc.id)).toBeUndefined();
    expect(screen.getByText('Nothing selected')).toBeVisible();

    act(() => editor().undo());
    expect(deviceIn(lab.r1.id)).toBeDefined();
    expect(deviceIn(lab.pc.id)).toBeDefined();
    expect(editor().topology.links[lab.wan.id]).toBeDefined();
  });

  it('falls back to the empty state when the selected device is deleted', () => {
    renderPanel();
    select([lab.sw.id]);
    expect(hostnameInput()).toHaveValue('SW1');

    act(() => editor().removeDevices([lab.sw.id]));
    expect(screen.getByText('Nothing selected')).toBeVisible();

    // The store pruned the selection, so undo brings the device back unselected.
    act(() => editor().undo());
    expect(deviceIn(lab.sw.id)).toBeDefined();
    expect(screen.getByText('Nothing selected')).toBeVisible();
  });

  it('falls back to the empty state when undo removes the selected device', () => {
    renderPanel();
    let added: DeviceId | undefined;
    act(() => {
      const { kind, model, position, ports, config } = lab.pc;
      const result = editor().addDevice({
        kind,
        model,
        position,
        ports,
        hostname: config.hostname,
      });
      if (result.ok) added = result.value;
    });
    select([added!]);
    expect(hostnameInput()).toBeVisible();

    act(() => editor().undo());
    expect(screen.getByText('Nothing selected')).toBeVisible();
  });

  it('edits a router interface address and admin state', () => {
    renderPanel();
    select([lab.r1.id]);
    openTab('Interfaces');

    fireEvent.click(screen.getByRole('button', { name: 'Edit Gi0/1 IP address' }));
    const form = screen.getByRole('form', { name: 'Gi0/1 IP address' });
    fireEvent.change(within(form).getByLabelText('IP address'), {
      target: { value: '172.16.0.0' },
    });
    fireEvent.change(within(form).getByLabelText('Subnet mask'), { target: { value: '/16' } });
    fireEvent.submit(form);
    expect(form).toHaveTextContent('This is the network address of the subnet');

    fireEvent.change(within(form).getByLabelText('IP address'), {
      target: { value: '172.16.0.1' },
    });
    fireEvent.submit(form);
    const router = deviceIn(lab.r1.id);
    if (router?.kind !== 'router') throw new Error('expected a router');
    expect(Object.values(router.config.interfaces)[1]?.ipv4).toEqual({
      address: '172.16.0.1',
      prefixLength: 16,
    });

    fireEvent.click(screen.getByRole('switch', { name: 'Gi0/1 enabled' }));
    expect(screen.getByRole('switch', { name: 'Gi0/1 enabled' })).toBeChecked();
    act(() => editor().undo());
    expect(screen.getByRole('switch', { name: 'Gi0/1 enabled' })).not.toBeChecked();
  });
});

describe('host IP configuration', () => {
  const field = (label: string) => screen.getByLabelText(label);
  const apply = () => fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
  const hostIpv4 = () => {
    const pc = deviceIn(lab.pc.id);
    if (pc?.kind !== 'pc') throw new Error('expected a PC');
    return pc.config.ipv4;
  };

  beforeEach(() => {
    renderPanel();
    select([lab.pc.id]);
    openTab('Config');
  });

  it('shows the current static configuration', () => {
    expect(field('IP address')).toHaveValue('192.168.1.10');
    expect(field('Subnet mask')).toHaveValue('255.255.255.0');
    expect(field('Default gateway')).toHaveValue('192.168.1.1');
    expect(field('DNS server')).toHaveValue('192.168.1.53');
  });

  it('applies a new address as one undo step', () => {
    fireEvent.change(field('IP address'), { target: { value: '10.0.5.20' } });
    fireEvent.change(field('Subnet mask'), { target: { value: '255.255.0.0' } });
    fireEvent.change(field('Default gateway'), { target: { value: '10.0.0.1' } });
    fireEvent.change(field('DNS server'), { target: { value: '' } });
    apply();

    expect(hostIpv4()).toEqual({
      mode: 'static',
      address: { address: '10.0.5.20', prefixLength: 16 },
      gateway: '10.0.0.1',
    });
    act(() => editor().undo());
    expect(field('IP address')).toHaveValue('192.168.1.10');
  });

  it('uses the classful mask, shown as the placeholder, when the mask is left empty', () => {
    fireEvent.change(field('Subnet mask'), { target: { value: '' } });
    fireEvent.change(field('IP address'), { target: { value: '172.20.1.4' } });
    fireEvent.change(field('Default gateway'), { target: { value: '172.20.0.1' } });
    expect(field('Subnet mask')).toHaveAttribute('placeholder', '255.255.0.0');
    apply();
    expect(hostIpv4()).toMatchObject({ address: { address: '172.20.1.4', prefixLength: 16 } });
  });

  it('rejects bad input inline and saves nothing', () => {
    const before = hostIpv4();
    fireEvent.change(field('IP address'), { target: { value: '192.168.1.300' } });
    fireEvent.change(field('Subnet mask'), { target: { value: '255.0.255.0' } });
    apply();
    expect(screen.getByText('Invalid IPv4 address')).toBeVisible();
    expect(screen.getByText('Subnet mask bits must be contiguous')).toBeVisible();
    expect(field('IP address')).toHaveAttribute('aria-invalid', 'true');
    expect(hostIpv4()).toEqual(before);
  });

  it('requires the gateway to be on the host subnet', () => {
    fireEvent.change(field('Default gateway'), { target: { value: '192.168.2.1' } });
    apply();
    expect(screen.getByText('The gateway must be in 192.168.1.0/24')).toBeVisible();
    expect(hostIpv4()).toMatchObject({ gateway: '192.168.1.1' });
  });

  it('switches to DHCP', () => {
    fireEvent.click(screen.getByRole('radio', { name: 'DHCP' }));
    expect(screen.getByText(/will come from a DHCP server/)).toBeVisible();
    apply();
    expect(hostIpv4()).toEqual({ mode: 'dhcp' });
  });
});
