import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Ipv6Status } from '@/engine/api';
import { Ipv6Address, type DeviceId } from '@/model';
import { useEditor } from '@/model/react';
import { editorStore } from '@/model/store';
import { HostIpv6Form } from './HostIpv6Form';
import { buildOffice } from './testing';

/** PC1's link-local address, from its MAC fe:a8:41:78:49:8f by EUI-64. */
const PC1_LINK_LOCAL = 'FE80::FCA8:41FF:FE78:498F';

const NO_IPV6: Ipv6Status = {
  routing: false,
  interfaces: [],
  routes: [],
  neighbors: [],
  ports: {},
};

let lab: ReturnType<typeof buildOffice>;

beforeEach(() => {
  lab = buildOffice();
  act(() => editorStore.getState().load(lab.topology));
});

const editor = () => editorStore.getState();

function pc1() {
  const pc = editor().topology.devices[lab.pc.id];
  if (pc?.kind !== 'pc') throw new Error('expected a PC');
  return pc;
}

const hostIpv6 = () => pc1().config.ipv6;

/** PC1's form, kept in step with the store as the desktop keeps it. */
function Pc1Form({ ipv6Status }: { ipv6Status: (device: DeviceId) => Promise<Ipv6Status> }) {
  const device = useEditor(({ topology }) => topology.devices[lab.pc.id]);
  if (device?.kind !== 'pc') return null;
  return <HostIpv6Form device={device} ipv6Status={ipv6Status} />;
}

function open(ipv6Status: (device: DeviceId) => Promise<Ipv6Status> = async () => NO_IPV6) {
  render(<Pc1Form ipv6Status={ipv6Status} />);
  return within(screen.getByRole('form', { name: 'IPv6 configuration' }));
}

describe('the IPv6 configuration form', () => {
  const apply = (form: ReturnType<typeof open>) =>
    fireEvent.click(form.getByRole('button', { name: 'Apply' }));

  it('starts static with no address, and always shows the link-local address', () => {
    const form = open();
    expect(form.getByRole('radio', { name: 'Static' })).toBeChecked();
    expect(form.getByLabelText('IPv6 address')).toHaveValue('');
    expect(form.getByLabelText('Prefix length')).toHaveValue('64');
    expect(form.getByText('Link-local address')).toBeVisible();
    expect(form.getByText(PC1_LINK_LOCAL)).toBeVisible();
  });

  it('applies a static address, prefix length and gateway as one undo step', () => {
    const form = open();
    fireEvent.change(form.getByLabelText('IPv6 address'), {
      target: { value: '2001:DB8:1:0::10' },
    });
    fireEvent.change(form.getByLabelText('Prefix length'), { target: { value: '48' } });
    fireEvent.change(form.getByLabelText('Default gateway'), { target: { value: 'fe80::1' } });
    apply(form);
    expect(hostIpv6()).toEqual({
      mode: 'static',
      address: { address: '2001:db8:1::10', prefixLength: 48 },
      gateway: 'fe80::1',
    });
    expect(form.getByLabelText('IPv6 address')).toHaveValue('2001:DB8:1::10');
    act(() => editor().undo());
    expect(hostIpv6()).toBeUndefined();
    expect(form.getByLabelText('IPv6 address')).toHaveValue('');
  });

  it('rejects bad input inline and saves nothing', () => {
    const form = open();
    fireEvent.change(form.getByLabelText('IPv6 address'), { target: { value: '2001:db8::1::2' } });
    fireEvent.change(form.getByLabelText('Prefix length'), { target: { value: '129' } });
    fireEvent.change(form.getByLabelText('Default gateway'), { target: { value: 'ff02::1' } });
    apply(form);
    expect(form.getByText('Invalid IPv6 address')).toBeVisible();
    expect(form.getByText('Prefix length must be 0 to 128')).toBeVisible();
    expect(form.getByText('The gateway must be a unicast address')).toBeVisible();
    expect(form.getByLabelText('IPv6 address')).toHaveAttribute('aria-invalid', 'true');
    expect(hostIpv6()).toBeUndefined();
  });

  it('requires a global gateway to be in the address prefix', () => {
    const form = open();
    fireEvent.change(form.getByLabelText('IPv6 address'), { target: { value: '2001:db8:1::10' } });
    fireEvent.change(form.getByLabelText('Default gateway'), {
      target: { value: '2001:db8:2::1' },
    });
    apply(form);
    expect(form.getByText('The gateway must be in 2001:DB8:1::/64, or link-local')).toBeVisible();
    expect(hostIpv6()).toBeUndefined();
  });

  it('switches to Automatic, then waits for a router advertisement', async () => {
    const form = open();
    fireEvent.click(form.getByRole('radio', { name: 'Automatic' }));
    expect(form.queryByLabelText('IPv6 address')).toBeNull();
    apply(form);
    expect(hostIpv6()).toEqual({ mode: 'auto' });
    expect(await form.findByRole('status', { name: 'IPv6 status' })).toHaveTextContent(
      'Waiting for a router advertisement…',
    );
  });

  it('shows the address and gateway a SLAAC host took, as the simulation reports them', async () => {
    let status = NO_IPV6;
    const ipv6Status = vi.fn(async () => status);
    act(() => {
      const { config } = pc1();
      editor().updateConfig({
        device: lab.pc.id,
        kind: 'pc',
        config: { ...config, ipv6: { mode: 'auto' } },
      });
    });
    const form = open(ipv6Status);
    expect(await form.findByText('Waiting for a router advertisement…')).toBeVisible();
    expect(ipv6Status).toHaveBeenCalledWith(lab.pc.id);
    status = {
      ...NO_IPV6,
      interfaces: [
        {
          name: 'FastEthernet0' as Ipv6Status['interfaces'][number]['name'],
          up: true,
          linkLocal: Ipv6Address.parse('fe80::fca8:41ff:fe78:498f'),
          addresses: [
            {
              address: Ipv6Address.parse('2001:db8:1:0:fca8:41ff:fe78:498f'),
              prefixLength: 64,
              origin: 'autoconfig',
            },
          ],
          groups: [],
        },
      ],
      gateway: Ipv6Address.parse('fe80::1'),
    };
    const shown = await form.findByText('2001:DB8:1:0:FCA8:41FF:FE78:498F/64', undefined, {
      timeout: 2000,
    });
    expect(shown).toBeVisible();
    expect(form.getByRole('status', { name: 'IPv6 status' })).toHaveTextContent('FE80::1');
  });
});
