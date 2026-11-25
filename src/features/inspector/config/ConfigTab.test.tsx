import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeviceSession, runningConfig, type IosDevice, type RouterDevice } from '@/cli';
import type { DeviceId, PortId, RouterConfig, SwitchConfig } from '@/model';
import { editorStore } from '@/model/store';
import { TooltipProvider } from '@/ui/tooltip';
import { InspectorPanel } from '../InspectorPanel';
import { buildOffice } from '../testing';

vi.mock('@/features/terminal/Terminal', () => ({ DeviceTerminal: () => null }));

let lab: ReturnType<typeof buildOffice>;

beforeEach(() => {
  localStorage.clear();
  lab = buildOffice();
  act(() => editorStore.getState().load(lab.topology));
});

const editor = () => editorStore.getState();
const undoSteps = () => editorStore.temporal.getState().pastStates.length;
const deviceIn = (id: DeviceId) => editor().topology.devices[id] as IosDevice;
const routerConfig = () => deviceIn(lab.r1.id).config as RouterConfig;
const switchConfig = () => deviceIn(lab.sw.id).config as SwitchConfig;
const port = (name: string) => name as PortId;

function openConfig(device: DeviceId) {
  render(
    <TooltipProvider>
      <InspectorPanel />
    </TooltipProvider>,
  );
  act(() => editor().select({ devices: [device], links: [] }));
  fireEvent.mouseDown(screen.getByRole('tab', { name: 'Config' }), { button: 0 });
}

const section = (name: string) => screen.getByRole('region', { name });
const type = (field: HTMLElement, value: string) => fireEvent.change(field, { target: { value } });
const enter = (field: HTMLElement) => fireEvent.keyDown(field, { key: 'Enter' });

/** Opens an interface's editor in the Interfaces section and returns its form. */
function editInterface(short: string) {
  const row = within(section('Interfaces')).getByRole('listitem', { name: short });
  fireEvent.click(within(row).getByRole('button', { name: `Edit ${short}` }));
  return within(row).getByRole('form', { name: `${short} settings` });
}

function showIos() {
  fireEvent.click(screen.getByRole('switch', { name: 'Show equivalent IOS' }));
}

/** The lines an IOS preview shows, without the prompts CSS draws in front of them. */
function previewIn(scope: HTMLElement) {
  const figure = within(scope).getByRole('figure', { name: 'IOS commands' });
  return {
    caption: figure.querySelector('figcaption')!.textContent,
    lines: [...figure.querySelectorAll('code > span')].map((line) => line.textContent),
    prompts: [...figure.querySelectorAll('code > span')].map((line) =>
      line.getAttribute('data-prompt'),
    ),
  };
}

describe('General', () => {
  it('renames on Enter as one undo step, and refuses an invalid hostname', () => {
    openConfig(lab.r1.id);
    const hostname = within(section('General')).getByRole('textbox', { name: 'Hostname' });
    const before = undoSteps();

    type(hostname, '1-bad');
    enter(hostname);
    expect(within(section('General')).getByRole('alert')).toHaveTextContent(
      'Hostname must start with a letter',
    );
    expect(routerConfig().hostname).toBe('R1');
    expect(undoSteps()).toBe(before);

    type(hostname, 'Edge');
    enter(hostname);
    expect(routerConfig().hostname).toBe('Edge');
    expect(undoSteps()).toBe(before + 1);

    act(() => editor().undo());
    expect(hostname).toHaveValue('R1');
  });

  it('sets a multi-line banner on blur and toggles password encryption', () => {
    openConfig(lab.r1.id);
    const general = section('General');
    const banner = within(general).getByRole('textbox', { name: 'Banner MOTD' });
    type(banner, 'Authorised access only\nR1 #3');
    fireEvent.blur(banner);
    expect(routerConfig().bannerMotd).toBe('Authorised access only\nR1 #3');

    const before = undoSteps();
    fireEvent.click(within(general).getByRole('switch', { name: 'Encrypt passwords' }));
    expect(routerConfig().servicePasswordEncryption).toBe(true);
    fireEvent.click(within(general).getByRole('switch', { name: 'Domain lookup' }));
    expect(routerConfig().domainLookup).toBe(false);
    expect(undoSteps()).toBe(before + 2);
  });

  it('sets and removes the enable secret', () => {
    openConfig(lab.r1.id);
    const general = section('General');
    const secret = within(general).getByRole('textbox', { name: 'Enable secret' });
    type(secret, 'class');
    enter(secret);
    expect(routerConfig().enableSecret).toMatch(/^\$1\$/);
    expect(secret).toHaveValue('');

    fireEvent.click(within(general).getByRole('button', { name: 'Remove' }));
    expect(routerConfig().enableSecret).toBeUndefined();
  });
});

describe('Interfaces', () => {
  it('applies description and address together as one undo step', () => {
    openConfig(lab.r1.id);
    const form = editInterface('Gi0/1');
    const before = undoSteps();

    type(within(form).getByLabelText('Description'), 'To the lab LAN');
    type(within(form).getByLabelText('IP address'), '10.1.1.1');
    type(within(form).getByLabelText('Subnet mask'), '255.255.255.0');
    fireEvent.submit(form);

    const gi01 = routerConfig().interfaces[port('GigabitEthernet0/1')];
    expect(gi01).toMatchObject({
      description: 'To the lab LAN',
      ipv4: { address: '10.1.1.1', prefixLength: 24 },
    });
    expect(undoSteps()).toBe(before + 1);

    act(() => editor().undo());
    const reverted = routerConfig().interfaces[port('GigabitEthernet0/1')];
    expect(reverted?.description).toBeUndefined();
    expect(reverted?.ipv4).toBeUndefined();
  });

  it('refuses an invalid address, and one IOS refuses, without committing', () => {
    openConfig(lab.r1.id);
    const form = editInterface('Gi0/1');
    const before = undoSteps();

    type(within(form).getByLabelText('IP address'), '10.1.1.300');
    fireEvent.submit(form);
    expect(within(form).getByText('Invalid IPv4 address')).toBeVisible();

    // Gi0/0 already has 192.168.1.1/24, so IOS refuses an overlapping subnet.
    type(within(form).getByLabelText('IP address'), '192.168.1.5');
    type(within(form).getByLabelText('Subnet mask'), '255.255.255.0');
    fireEvent.submit(form);
    expect(within(form).getByRole('alert')).toHaveTextContent(
      '192.168.1.0 overlaps with GigabitEthernet0/0',
    );
    expect(undoSteps()).toBe(before);
    expect(routerConfig().interfaces[port('GigabitEthernet0/1')]?.ipv4).toBeUndefined();
  });

  it('sets clock rate on a serial port and shuts a port from its switch', () => {
    openConfig(lab.r1.id);
    const form = editInterface('Se0/0/0');
    fireEvent.change(within(form).getByLabelText('Clock rate (DCE end)'), {
      target: { value: '64000' },
    });
    fireEvent.submit(form);
    expect(routerConfig().interfaces[port('Serial0/0/0')]?.clockRate).toBe(64000);

    const row = within(section('Interfaces')).getByRole('listitem', { name: 'Gi0/0' });
    fireEvent.click(within(row).getByRole('switch', { name: 'Gi0/0 enabled' }));
    expect(routerConfig().interfaces[port('GigabitEthernet0/0')]?.shutdown).toBe(true);
  });

  it('gives the same config as typing the commands at the CLI', () => {
    const original = lab.r1 as RouterDevice;
    const session = createDeviceSession();
    let typed: IosDevice = original;
    for (const line of [
      'enable',
      'configure terminal',
      'interface GigabitEthernet0/1',
      'ip address 10.1.1.1 255.255.255.0',
      'end',
    ]) {
      const { update } = session.run(typed, line);
      if (update) typed = { ...typed, config: update.config } as IosDevice;
    }

    openConfig(lab.r1.id);
    const form = editInterface('Gi0/1');
    type(within(form).getByLabelText('IP address'), '10.1.1.1');
    type(within(form).getByLabelText('Subnet mask'), '/24');
    fireEvent.submit(form);

    expect(routerConfig()).toEqual(typed.config);
  });
});

describe('Static routes', () => {
  it('adds and removes a route, each as one undo step', () => {
    openConfig(lab.r1.id);
    const routes = section('Static routes');
    const form = within(routes).getByRole('form', { name: 'Add a static route' });
    const before = undoSteps();

    type(within(form).getByLabelText('Network'), '172.16.0.0');
    type(within(form).getByLabelText('Mask'), '255.255.0.0');
    type(within(form).getByLabelText('Next-hop address'), '10.0.0.2');
    fireEvent.submit(form);

    expect(routerConfig().staticRoutes).toEqual([
      {
        prefix: { address: '172.16.0.0', prefixLength: 16 },
        nextHop: { kind: 'address', address: '10.0.0.2' },
      },
    ]);
    expect(undoSteps()).toBe(before + 1);
    expect(within(form).getByLabelText('Network')).toHaveValue('');

    fireEvent.click(
      within(routes).getByRole('button', { name: 'Remove route 172.16.0.0/16 via 10.0.0.2' }),
    );
    expect(routerConfig().staticRoutes).toEqual([]);
    expect(undoSteps()).toBe(before + 2);
  });

  it('routes out an exit interface', () => {
    openConfig(lab.r1.id);
    const form = within(section('Static routes')).getByRole('form', { name: 'Add a static route' });
    type(within(form).getByLabelText('Network'), '0.0.0.0');
    type(within(form).getByLabelText('Mask'), '0.0.0.0');
    fireEvent.click(within(form).getByRole('radio', { name: 'Exit interface' }));
    fireEvent.change(within(form).getByRole('combobox', { name: 'Exit interface' }), {
      target: { value: 'Serial0/0/0' },
    });
    fireEvent.submit(form);
    expect(routerConfig().staticRoutes[0]?.nextHop).toEqual({
      kind: 'interface',
      interface: 'Serial0/0/0',
    });
  });

  it('refuses a network with host bits set, and a missing next hop', () => {
    openConfig(lab.r1.id);
    const form = within(section('Static routes')).getByRole('form', { name: 'Add a static route' });
    const before = undoSteps();
    type(within(form).getByLabelText('Network'), '172.16.5.0');
    type(within(form).getByLabelText('Mask'), '255.255.0.0');
    fireEvent.submit(form);
    expect(within(form).getByText('Enter the next-hop address')).toBeVisible();

    type(within(form).getByLabelText('Next-hop address'), '10.0.0.2');
    fireEvent.submit(form);
    expect(
      within(form).getByText('Host bits are set for this mask. The network is 172.16.0.0'),
    ).toBeVisible();
    expect(routerConfig().staticRoutes).toEqual([]);
    expect(undoSteps()).toBe(before);
  });
});

describe('Switch', () => {
  it('adds a VLAN and puts a port in it', () => {
    openConfig(lab.sw.id);
    const vlans = section('VLANs');
    const form = within(vlans).getByRole('form', { name: 'Add a VLAN' });
    const before = undoSteps();

    type(within(form).getByLabelText('VLAN ID'), '10');
    type(within(form).getByLabelText('Name'), 'Sales');
    fireEvent.submit(form);
    expect(switchConfig().vlans[10 as never]).toEqual({ name: 'Sales' });
    expect(undoSteps()).toBe(before + 1);

    fireEvent.change(within(vlans).getByRole('combobox', { name: 'Fa0/3 access VLAN' }), {
      target: { value: '10' },
    });
    expect(switchConfig().interfaces[port('FastEthernet0/3')]?.switchport).toEqual({
      mode: 'access',
      vlan: 10,
    });
    expect(within(vlans).getByRole('listitem', { name: 'VLAN 10' })).toHaveTextContent('1 port');
    expect(undoSteps()).toBe(before + 2);
  });

  it('renames and removes a VLAN, and refuses a duplicate or a bad name', () => {
    openConfig(lab.sw.id);
    const vlans = section('VLANs');
    const form = within(vlans).getByRole('form', { name: 'Add a VLAN' });
    type(within(form).getByLabelText('VLAN ID'), '20');
    fireEvent.submit(form);
    expect(switchConfig().vlans[20 as never]).toEqual({ name: 'VLAN0020' });

    type(within(form).getByLabelText('VLAN ID'), '20');
    fireEvent.submit(form);
    expect(within(form).getByText('VLAN 20 already exists')).toBeVisible();

    const name = within(vlans).getByRole('textbox', { name: 'VLAN 20 name' });
    type(name, 'Two words');
    enter(name);
    expect(within(vlans).getByRole('alert')).toHaveTextContent('One word of up to 32 characters');
    type(name, 'Staff');
    enter(name);
    expect(switchConfig().vlans[20 as never]).toEqual({ name: 'Staff' });

    fireEvent.click(within(vlans).getByRole('button', { name: 'Remove VLAN 20' }));
    expect(20 in switchConfig().vlans).toBe(false);
  });

  it('makes a port a trunk with a native VLAN', () => {
    openConfig(lab.sw.id);
    const vlans = section('VLANs');
    fireEvent.change(within(vlans).getByRole('combobox', { name: 'Gi0/2 mode' }), {
      target: { value: 'trunk' },
    });
    expect(switchConfig().interfaces[port('GigabitEthernet0/2')]?.switchport).toEqual({
      mode: 'trunk',
      nativeVlan: 1,
    });
  });

  it('sets the default gateway and refuses an invalid one', () => {
    openConfig(lab.sw.id);
    const gateway = within(section('Default gateway')).getByRole('textbox', { name: 'Gateway' });
    type(gateway, '192.168.1.999');
    enter(gateway);
    expect(within(section('Default gateway')).getByRole('alert')).toHaveTextContent(
      'Invalid IPv4 address',
    );
    expect(switchConfig().defaultGateway).toBeUndefined();

    type(gateway, '192.168.1.1');
    enter(gateway);
    expect(switchConfig().defaultGateway).toBe('192.168.1.1');
  });
});

describe('Lines', () => {
  it('sets the vty password, login and transport for all 16 lines', () => {
    openConfig(lab.r1.id);
    const vty = within(section('Lines')).getByRole('group', { name: 'VTY 0–15' });
    const password = within(vty).getByRole('textbox', { name: 'Password' });
    type(password, 'cisco');
    enter(password);
    fireEvent.change(within(vty).getByRole('combobox', { name: 'Transport input' }), {
      target: { value: 'ssh' },
    });
    const { vty: lines } = routerConfig().lines;
    expect(lines.every((line) => line.password === 'cisco')).toBe(true);
    expect(lines.every((line) => !line.transportInput.telnet && line.transportInput.ssh)).toBe(
      true,
    );

    const console = within(section('Lines')).getByRole('group', { name: 'Console' });
    fireEvent.change(within(console).getByRole('combobox', { name: 'Login' }), {
      target: { value: 'password' },
    });
    expect(routerConfig().lines.console.login).toBe('password');
  });
});

describe('Show equivalent IOS', () => {
  it('previews the lines a draft will run, then shows what ran', () => {
    openConfig(lab.r1.id);
    showIos();
    const form = editInterface('Gi0/1');
    type(within(form).getByLabelText('Description'), 'Uplink');
    type(within(form).getByLabelText('IP address'), '10.1.1.1');
    type(within(form).getByLabelText('Subnet mask'), '255.255.255.0');

    const interfaces = section('Interfaces');
    expect(previewIn(interfaces)).toEqual({
      caption: 'Will runCopy',
      lines: [
        'interface GigabitEthernet0/1',
        ' description Uplink',
        ' ip address 10.1.1.1 255.255.255.0',
      ],
      prompts: ['R1(config)#', 'R1(config-if)#', 'R1(config-if)#'],
    });

    fireEvent.submit(form);
    expect(previewIn(interfaces).caption).toBe('Last runCopy');
    // What ran is in the running-config.
    expect(runningConfig(deviceIn(lab.r1.id))).toEqual(
      expect.arrayContaining([' description Uplink', ' ip address 10.1.1.1 255.255.255.0']),
    );
  });

  it('shows the lines for a route, a toggle and a VLAN', () => {
    openConfig(lab.r1.id);
    showIos();
    const routes = section('Static routes');
    const form = within(routes).getByRole('form', { name: 'Add a static route' });
    type(within(form).getByLabelText('Network'), '172.16.0.0');
    type(within(form).getByLabelText('Mask'), '/16');
    type(within(form).getByLabelText('Next-hop address'), '10.0.0.2');
    expect(previewIn(routes).lines).toEqual(['ip route 172.16.0.0 255.255.0.0 10.0.0.2']);

    const general = section('General');
    fireEvent.click(within(general).getByRole('switch', { name: 'Domain lookup' }));
    expect(previewIn(general).lines).toEqual(['no ip domain-lookup']);

    act(() => editor().select({ devices: [lab.sw.id], links: [] }));
    const vlans = section('VLANs');
    const vlanForm = within(vlans).getByRole('form', { name: 'Add a VLAN' });
    type(within(vlanForm).getByLabelText('VLAN ID'), '30');
    type(within(vlanForm).getByLabelText('Name'), 'Voice');
    expect(previewIn(vlans)).toMatchObject({
      lines: ['vlan 30', ' name Voice'],
      prompts: ['SW1(config)#', 'SW1(config-vlan)#'],
    });
  });

  it('remembers the toggle across devices and hides the preview when off', () => {
    openConfig(lab.r1.id);
    expect(screen.queryByRole('figure', { name: 'IOS commands' })).toBeNull();
    showIos();
    act(() => editor().select({ devices: [lab.sw.id], links: [] }));
    expect(screen.getByRole('switch', { name: 'Show equivalent IOS' })).toBeChecked();
    showIos();
  });
});

describe('CLI edits', () => {
  it('show in the forms at once', () => {
    openConfig(lab.r1.id);
    const session = createDeviceSession({ mode: { kind: 'global-config' } });
    const run = (line: string) => {
      const { update } = session.run(deviceIn(lab.r1.id), line);
      if (update) act(() => void editor().updateConfig(update));
    };
    run('hostname Core');
    run('interface GigabitEthernet0/1');
    run('description From the CLI');
    run('ip address 10.9.9.1 255.255.255.0');

    expect(within(section('General')).getByRole('textbox', { name: 'Hostname' })).toHaveValue(
      'Core',
    );
    const row = within(section('Interfaces')).getByRole('listitem', { name: 'Gi0/1' });
    expect(row).toHaveTextContent('10.9.9.1/24');
    expect(row).toHaveTextContent('From the CLI');

    const form = editInterface('Gi0/1');
    expect(within(form).getByLabelText('Description')).toHaveValue('From the CLI');
  });
});
