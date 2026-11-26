import { useEffect, useId, useState, type FormEvent } from 'react';
import type { Ipv6Status } from '@/engine/api';
import type { Device, DeviceId, HostIpv6 } from '@/model';
import {
  inIpv6Prefix,
  iosIpv6,
  iosIpv6Cidr,
  ipv6Prefix,
  isIpv6Multicast,
  isLinkLocal,
  linkLocalOf,
  readIpv6,
  UNSPECIFIED_IPV6,
} from '@/model/ipv6';
import { editorStore } from '@/model/store';
import { Button } from '@/ui/button';
import { Segmented } from '@/ui/segmented';
import { Field } from './Field';

type Form = { mode: HostIpv6['mode']; address: string; prefix: string; gateway: string };
type Errors = Partial<Record<'address' | 'prefix' | 'gateway', string>>;

const DEFAULT_PREFIX = '64';

/** How often the form asks the simulation what a SLAAC host has. */
const POLL_MS = 1000;

function formFrom(ipv6: HostIpv6 | undefined): Form {
  if (ipv6?.mode === 'auto') {
    return { mode: 'auto', address: '', prefix: DEFAULT_PREFIX, gateway: '' };
  }
  return {
    mode: 'static',
    address: ipv6?.address ? iosIpv6(ipv6.address.address) : '',
    prefix: ipv6?.address ? String(ipv6.address.prefixLength) : DEFAULT_PREFIX,
    gateway: ipv6?.gateway ? iosIpv6(ipv6.gateway) : '',
  };
}

function parseForm(form: Form): { ok: true; value: HostIpv6 } | { ok: false; errors: Errors } {
  if (form.mode === 'auto') return { ok: true, value: { mode: 'auto' } };

  const errors: Errors = {};
  const value: Extract<HostIpv6, { mode: 'static' }> = { mode: 'static' };
  const addressText = form.address.trim();
  if (addressText) {
    const address = readIpv6(addressText);
    const prefixText = form.prefix.trim() || DEFAULT_PREFIX;
    const prefixLength = /^\d{1,3}$/.test(prefixText) ? Number(prefixText) : NaN;
    if (!address) errors.address = 'Invalid IPv6 address';
    else if (address === UNSPECIFIED_IPV6 || isIpv6Multicast(address)) {
      errors.address = 'The address must be a unicast address';
    } else if (isLinkLocal(address)) {
      errors.address = 'The link-local address comes from the MAC; enter a global one';
    }
    if (!(prefixLength >= 0 && prefixLength <= 128)) {
      errors.prefix = 'Prefix length must be 0 to 128';
    }
    if (address && !errors.address && !errors.prefix) value.address = { address, prefixLength };
  }

  const gatewayText = form.gateway.trim();
  if (gatewayText) {
    const gateway = readIpv6(gatewayText);
    if (!gateway) errors.gateway = 'Invalid IPv6 address';
    else if (gateway === UNSPECIFIED_IPV6 || isIpv6Multicast(gateway)) {
      errors.gateway = 'The gateway must be a unicast address';
    } else if (!isLinkLocal(gateway) && !addressText) {
      errors.gateway = 'Set an IPv6 address before a global gateway';
    } else if (!isLinkLocal(gateway) && value.address && !inIpv6Prefix(value.address, gateway)) {
      const prefix = iosIpv6Cidr(ipv6Prefix(value.address));
      errors.gateway = `The gateway must be in ${prefix}, or link-local`;
    } else {
      value.gateway = gateway;
    }
  }

  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, value };
}

/** Facts as label and value, in the inspector's small monospace style. */
function Facts({ facts }: { facts: readonly [string, string][] }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
      {facts.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-fg-3">{label}</dt>
          <dd className="font-mono break-all text-fg-1 tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** What a SLAAC host has now, asked of the simulation about once a second while shown. */
function SlaacStatus({
  device,
  ipv6Status,
}: {
  device: DeviceId;
  ipv6Status: (device: DeviceId) => Promise<Ipv6Status>;
}) {
  const [status, setStatus] = useState<Ipv6Status>();
  useEffect(() => {
    let stopped = false;
    const poll = () =>
      ipv6Status(device).then(
        (next) => !stopped && setStatus(next),
        () => !stopped && setStatus(undefined),
      );
    void poll();
    const timer = setInterval(poll, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [device, ipv6Status]);

  const address = status?.interfaces[0]?.addresses.find((entry) => entry.origin === 'autoconfig');
  return (
    <div role="status" aria-label="IPv6 status" className="flex flex-col gap-2">
      {address ? (
        <Facts
          facts={[
            ['IPv6 address', iosIpv6Cidr(address)],
            ['Default gateway', status?.gateway ? iosIpv6(status.gateway) : 'None'],
          ]}
        />
      ) : (
        <p className="text-xs text-fg-2">Waiting for a router advertisement…</p>
      )}
    </div>
  );
}

/**
 * The host's IPv6 configuration: an address from router advertisements (SLAAC), or a static
 * address, prefix length and gateway. Applies as one undo step. The link-local address always
 * comes from the MAC. With Automatic applied, it shows what the host took from a router.
 */
export function HostIpv6Form({
  device,
  ipv6Status,
}: {
  device: Extract<Device, { kind: 'pc' | 'server' }>;
  ipv6Status: (device: DeviceId) => Promise<Ipv6Status>;
}) {
  const { config } = device;
  const [draft, setDraft] = useState<Form | null>(null);
  const [errors, setErrors] = useState<Errors>({});
  const id = useId();
  const form = draft ?? formFrom(config.ipv6);
  const port = device.ports.find((candidate) => candidate.kind !== 'serial');

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
      config: { ...config, ipv6: parsed.value },
    });
    reset();
  };

  const auto = form.mode === 'auto';
  const field = (
    key: keyof Errors,
    label: string,
    placeholder: string,
    inputMode: 'text' | 'numeric',
  ) => (
    <Field
      id={`${id}-${key}`}
      label={label}
      value={form[key]}
      error={errors[key]}
      placeholder={placeholder}
      inputMode={inputMode}
      onChange={(value) => edit({ [key]: value })}
    />
  );

  return (
    <form
      aria-label="IPv6 configuration"
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
        label="IPv6 mode"
        value={form.mode}
        onValueChange={(mode) => edit({ mode })}
        options={[
          { value: 'auto', label: 'Automatic' },
          { value: 'static', label: 'Static' },
        ]}
        className="self-start"
      />
      {port && <Facts facts={[['Link-local address', iosIpv6(linkLocalOf(port.mac))]]} />}
      {auto && config.ipv6?.mode === 'auto' && !draft ? (
        <SlaacStatus device={device.id} ipv6Status={ipv6Status} />
      ) : auto ? (
        <p className="text-xs text-fg-2">
          The address and gateway will come from a router’s advertisements on this network.
        </p>
      ) : (
        <div className="grid grid-cols-[1fr_6rem] gap-x-2 gap-y-2.5">
          {field('address', 'IPv6 address', '2001:DB8:1::10', 'text')}
          {field('prefix', 'Prefix length', DEFAULT_PREFIX, 'numeric')}
          <div className="col-span-2">{field('gateway', 'Default gateway', 'FE80::1', 'text')}</div>
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
