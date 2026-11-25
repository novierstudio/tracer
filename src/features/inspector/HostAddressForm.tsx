import { useId, useState, type FormEvent } from 'react';
import { formatSubnetMask, type Device, type HostIpv4 } from '@/model';
import { editorStore } from '@/model/store';
import { Button } from '@/ui/button';
import { Segmented } from '@/ui/segmented';
import { Field } from './Field';
import {
  classfulMask,
  formatCidr,
  inSubnet,
  networkOf,
  parseInterfaceAddress,
  parseOptionalAddress,
} from './ipv4';

type Form = { mode: HostIpv4['mode']; address: string; mask: string; gateway: string; dns: string };
type Errors = Partial<Record<'address' | 'mask' | 'gateway' | 'dns', string>>;

function formFrom(ipv4: HostIpv4): Form {
  if (ipv4.mode === 'dhcp') return { mode: 'dhcp', address: '', mask: '', gateway: '', dns: '' };
  return {
    mode: 'static',
    address: ipv4.address?.address ?? '',
    mask: ipv4.address ? formatSubnetMask(ipv4.address.prefixLength) : '',
    gateway: ipv4.gateway ?? '',
    dns: ipv4.dns ?? '',
  };
}

function parseForm(form: Form): { ok: true; value: HostIpv4 } | { ok: false; errors: Errors } {
  if (form.mode === 'dhcp') return { ok: true, value: { mode: 'dhcp' } };

  const address = parseInterfaceAddress(form.address, form.mask);
  const gateway = parseOptionalAddress(form.gateway);
  const dns = parseOptionalAddress(form.dns);
  const errors: Errors = {
    ...(address.ok ? {} : address.error),
    ...(gateway.ok ? {} : { gateway: gateway.error }),
    ...(dns.ok ? {} : { dns: dns.error }),
  };
  if (address.ok && gateway.ok && gateway.value) {
    if (!address.value) errors.gateway = 'Set an IP address before a gateway';
    else if (!inSubnet(address.value, gateway.value)) {
      const subnet = formatCidr({ ...address.value, address: networkOf(address.value) });
      errors.gateway = `The gateway must be in ${subnet}`;
    }
  }
  if (!address.ok || !gateway.ok || !dns.ok || Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }
  const value: HostIpv4 = { mode: 'static' };
  if (address.value) value.address = address.value;
  if (gateway.value) value.gateway = gateway.value;
  if (dns.value) value.dns = dns.value;
  return { ok: true, value };
}

/**
 * The PC's "IP Configuration": static address, mask, gateway and DNS, or DHCP. Applies as one
 * undo step. Like the hostname, it shows the store until the user starts editing.
 */
export function HostAddressForm({
  device,
}: {
  device: Extract<Device, { kind: 'pc' | 'server' }>;
}) {
  const { config } = device;
  const [draft, setDraft] = useState<Form | null>(null);
  const [errors, setErrors] = useState<Errors>({});
  const id = useId();
  const form = draft ?? formFrom(config.ipv4);

  const edit = (patch: Partial<Form>) => {
    setDraft({ ...form, ...patch });
    setErrors((current) => {
      const next = { ...current };
      for (const key of Object.keys(patch)) delete next[key as keyof Errors];
      return next;
    });
  };

  const reset = () => {
    setDraft(null);
    setErrors({});
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = parseForm(form);
    if (!parsed.ok) return setErrors(parsed.errors);
    editorStore.getState().updateConfig({
      device: device.id,
      kind: device.kind,
      config: { ...config, ipv4: parsed.value },
    });
    reset();
  };

  const dhcp = form.mode === 'dhcp';
  const field = (key: keyof Errors, label: string, placeholder: string) => (
    <Field
      id={`${id}-${key}`}
      label={label}
      value={form[key]}
      error={errors[key]}
      placeholder={placeholder}
      onChange={(value) => edit({ [key]: value })}
    />
  );

  return (
    <form
      aria-label="IP configuration"
      onSubmit={submit}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && draft) {
          event.preventDefault();
          reset();
        }
      }}
      className="flex flex-col gap-3"
    >
      <Segmented
        label="Address mode"
        value={form.mode}
        onValueChange={(mode) => edit({ mode })}
        options={[
          { value: 'static', label: 'Static' },
          { value: 'dhcp', label: 'DHCP', disabled: config.ipv4.mode !== 'dhcp' },
        ]}
        className="self-start"
      />
      {config.ipv4.mode !== 'dhcp' && (
        <p className="text-2xs text-fg-3">DHCP arrives with DHCP servers in a later update.</p>
      )}
      {dhcp ? (
        <p className="text-xs text-fg-2">
          The address, gateway and DNS server will come from a DHCP server on this network.
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-x-2 gap-y-2.5">
          {field('address', 'IP address', '192.168.1.10')}
          {field('mask', 'Subnet mask', classfulMask(form.address) ?? '255.255.255.0')}
          {field('gateway', 'Default gateway', '192.168.1.1')}
          {field('dns', 'DNS server', '192.168.1.53')}
        </div>
      )}
      <div className="flex items-center justify-end gap-1.5">
        <Button size="sm" variant="ghost" onClick={reset} disabled={!draft}>
          Revert
        </Button>
        <Button size="sm" variant="primary" type="submit" disabled={!draft}>
          Apply
        </Button>
      </div>
    </form>
  );
}
