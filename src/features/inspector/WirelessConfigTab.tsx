import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { useHostAddressing } from '@/features/simulation/hostAddresses';
import {
  dhcpLast,
  formatSubnetMask,
  Ssid,
  WirelessSecurity,
  type Device,
  type HostIpv4,
  type WirelessRadio,
  type WirelessRouterConfig,
} from '@/model';
import { editorStore } from '@/model/store';
import { Button } from '@/ui/button';
import { Segmented } from '@/ui/segmented';
import { Field } from './Field';
import { formatCidr, inSubnet, parseInterfaceAddress, parseOptionalAddress } from './ipv4';
import { Section } from './parts';

type Radio = Extract<Device, { kind: 'accessPoint' | 'wirelessRouter' }>;

type Form = {
  ssid: string;
  channel: string;
  security: WirelessSecurity['mode'];
  passphrase: string;
  wanMode: HostIpv4['mode'];
  wanAddress: string;
  wanMask: string;
  wanGateway: string;
  wanDns: string;
  lanAddress: string;
  lanMask: string;
  dhcp: 'enabled' | 'disabled';
  dhcpStart: string;
  dhcpMax: string;
};
type Errors = Partial<Record<keyof Form, string>>;

const CHANNELS = Array.from({ length: 11 }, (_, i) => i + 1);

function formFrom(device: Radio): Form {
  const { radio } = device.config;
  const router: WirelessRouterConfig | undefined =
    device.kind === 'wirelessRouter' ? device.config : undefined;
  const wan = router?.wan;
  return {
    ssid: radio.ssid,
    channel: String(radio.channel),
    security: radio.security.mode,
    passphrase: radio.security.mode === 'wpa2-psk' ? radio.security.passphrase : '',
    wanMode: wan?.mode ?? 'dhcp',
    wanAddress: wan?.mode === 'static' ? (wan.address?.address ?? '') : '',
    wanMask:
      wan?.mode === 'static' && wan.address ? formatSubnetMask(wan.address.prefixLength) : '',
    wanGateway: wan?.mode === 'static' ? (wan.gateway ?? '') : '',
    wanDns: wan?.mode === 'static' ? (wan.dns ?? '') : '',
    lanAddress: router?.lan.address ?? '',
    lanMask: router ? formatSubnetMask(router.lan.prefixLength) : '',
    dhcp: router?.dhcp.enabled === false ? 'disabled' : 'enabled',
    dhcpStart: router?.dhcp.start ?? '',
    dhcpMax: router ? String(router.dhcp.maxUsers) : '',
  };
}

const firstIssue = (error: { issues: readonly { message: string }[] }) =>
  error.issues[0]?.message ?? 'Invalid value';

function parseRadio(form: Form, errors: Errors): WirelessRadio | undefined {
  const ssid = Ssid.safeParse(form.ssid);
  if (!ssid.success) errors.ssid = firstIssue(ssid.error);
  const security = WirelessSecurity.safeParse(
    form.security === 'none'
      ? { mode: 'none' }
      : { mode: form.security, passphrase: form.passphrase },
  );
  if (!security.success) errors.passphrase = firstIssue(security.error);
  if (!ssid.success || !security.success) return undefined;
  return { ssid: ssid.data, security: security.data, channel: Number(form.channel) };
}

function parseRouter(
  form: Form,
  current: WirelessRouterConfig,
  errors: Errors,
): Omit<WirelessRouterConfig, 'hostname' | 'radio'> | undefined {
  let wan: HostIpv4 = { mode: 'dhcp' };
  if (form.wanMode === 'static') {
    const address = parseInterfaceAddress(form.wanAddress, form.wanMask);
    const gateway = parseOptionalAddress(form.wanGateway);
    const dns = parseOptionalAddress(form.wanDns);
    if (!address.ok) {
      if (address.error.address) errors.wanAddress = address.error.address;
      if (address.error.mask) errors.wanMask = address.error.mask;
    }
    if (!gateway.ok) errors.wanGateway = gateway.error;
    if (!dns.ok) errors.wanDns = dns.error;
    if (address.ok && gateway.ok && dns.ok) {
      wan = { mode: 'static' };
      if (address.value) wan.address = address.value;
      if (gateway.value) wan.gateway = gateway.value;
      if (dns.value) wan.dns = dns.value;
    }
  }
  const lan = parseInterfaceAddress(form.lanAddress, form.lanMask);
  if (!lan.ok) {
    if (lan.error.address) errors.lanAddress = lan.error.address;
    if (lan.error.mask) errors.lanMask = lan.error.mask;
  } else if (!lan.value) errors.lanAddress = 'The router needs an IP address on its LAN';
  const start = parseOptionalAddress(form.dhcpStart);
  const max = Number(form.dhcpMax);
  if (!start.ok || !start.value)
    errors.dhcpStart = start.ok ? 'Enter a start address' : start.error;
  else if (lan.ok && lan.value && !inSubnet(lan.value, start.value)) {
    errors.dhcpStart = `The start address must be in ${formatCidr(lan.value)}`;
  }
  if (!Number.isInteger(max) || max < 1 || max > 253) errors.dhcpMax = 'Enter 1 to 253 users';
  if (Object.keys(errors).length > 0 || !lan.ok || !lan.value || !start.ok || !start.value) {
    return undefined;
  }
  return {
    wan,
    lan: lan.value,
    dhcp: { ...current.dhcp, enabled: form.dhcp === 'enabled', start: start.value, maxUsers: max },
  };
}

/** The Internet address a home router holds now: its lease, or its static address. */
function WanStatus({ device }: { device: Extract<Device, { kind: 'wirelessRouter' }> }) {
  const addressing = useHostAddressing(device.id);
  if (device.config.wan.mode === 'static') return null;
  const text =
    addressing?.kind === 'leased'
      ? `Leased ${formatCidr(addressing.address)}, gateway ${addressing.gateway ?? 'none'}`
      : 'Waiting for an address from the ISP…';
  return (
    <p role="status" aria-label="Internet status" className="text-xs text-fg-2">
      {text}
    </p>
  );
}

function Grid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-x-2 gap-y-2.5">{children}</div>;
}

/**
 * The web GUI of a home wireless router, or an access point's wireless settings, as Packet
 * Tracer's GUI tab has them: Internet setup, network setup with the DHCP server, and the wireless
 * network. Applies as one undo step.
 */
export function WirelessConfigTab({ device }: { device: Radio }) {
  const [draft, setDraft] = useState<Form | null>(null);
  const [errors, setErrors] = useState<Errors>({});
  const id = useId();
  const form = draft ?? formFrom(device);
  const router = device.kind === 'wirelessRouter' ? device : undefined;

  const edit = (patch: Partial<Form>) => {
    setDraft({ ...form, ...patch });
    setErrors((current) => {
      const next = { ...current };
      for (const key of Object.keys(patch)) delete next[key as keyof Form];
      return next;
    });
  };
  const reset = () => {
    setDraft(null);
    setErrors({});
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const found: Errors = {};
    const radio = parseRadio(form, found);
    const settings = router && parseRouter(form, router.config, found);
    if (!radio || (router && !settings)) return setErrors(found);
    const store = editorStore.getState();
    if (device.kind === 'accessPoint') {
      store.updateConfig({
        device: device.id,
        kind: device.kind,
        config: { ...device.config, radio },
      });
    } else if (settings) {
      store.updateConfig({
        device: device.id,
        kind: device.kind,
        config: { ...device.config, ...settings, radio },
      });
    }
    reset();
  };

  const field = (key: keyof Form, label: string, placeholder: string, text = false) => (
    <Field
      id={`${id}-${key}`}
      label={label}
      value={form[key]}
      error={errors[key]}
      placeholder={placeholder}
      inputMode={text ? 'text' : 'decimal'}
      onChange={(value) => edit({ [key]: value })}
    />
  );

  return (
    <form
      aria-label="Wireless settings"
      onSubmit={submit}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && draft) {
          event.preventDefault();
          reset();
        }
      }}
    >
      {router && (
        <Section title="Internet setup">
          <div className="flex flex-col gap-3">
            <Segmented
              label="Internet connection type"
              value={form.wanMode}
              onValueChange={(wanMode) => edit({ wanMode })}
              options={[
                { value: 'dhcp', label: 'Automatic (DHCP)' },
                { value: 'static', label: 'Static IP' },
              ]}
              className="self-start"
            />
            {form.wanMode === 'dhcp' ? (
              <WanStatus device={router} />
            ) : (
              <Grid>
                {field('wanAddress', 'Internet IP address', '203.0.113.2')}
                {field('wanMask', 'Subnet mask', '255.255.255.0')}
                {field('wanGateway', 'Default gateway', '203.0.113.1')}
                {field('wanDns', 'DNS 1', '203.0.113.53')}
              </Grid>
            )}
          </div>
        </Section>
      )}
      {router && (
        <Section title="Network setup" className="border-t border-line">
          <div className="flex flex-col gap-3">
            <Grid>
              {field('lanAddress', 'Router IP', '192.168.0.1')}
              {field('lanMask', 'Subnet mask', '255.255.255.0')}
            </Grid>
            <Segmented
              label="DHCP server"
              value={form.dhcp}
              onValueChange={(dhcp) => edit({ dhcp })}
              options={[
                { value: 'enabled', label: 'DHCP enabled' },
                { value: 'disabled', label: 'Disabled' },
              ]}
              className="self-start"
            />
            {form.dhcp === 'enabled' && (
              <>
                <Grid>
                  {field('dhcpStart', 'Start IP address', '192.168.0.100')}
                  {field('dhcpMax', 'Maximum users', '50')}
                </Grid>
                {!draft && (
                  <p className="text-2xs text-fg-3">
                    Lends {router.config.dhcp.start} to {dhcpLast(router.config)}.
                  </p>
                )}
              </>
            )}
          </div>
        </Section>
      )}
      <Section title="Wireless" className={router ? 'border-t border-line' : undefined}>
        <div className="flex flex-col gap-3">
          <Grid>
            {field('ssid', 'Network name (SSID)', 'Default', true)}
            <div className="flex min-w-0 flex-col gap-1">
              <label htmlFor={`${id}-channel`} className="text-2xs text-fg-3">
                Channel
              </label>
              <select
                id={`${id}-channel`}
                value={form.channel}
                onChange={(event) => edit({ channel: event.target.value })}
                className="h-7 rounded-md border border-line bg-surface-1 px-1.5 text-[0.6875rem] text-fg-1"
              >
                {CHANNELS.map((channel) => (
                  <option key={channel} value={channel}>
                    {channel}
                  </option>
                ))}
              </select>
            </div>
          </Grid>
          <Segmented
            label="Security mode"
            value={form.security}
            onValueChange={(security) => edit({ security })}
            options={[
              { value: 'none', label: 'Disabled' },
              { value: 'wpa2-psk', label: 'WPA2 Personal' },
            ]}
            className="self-start"
          />
          {form.security === 'wpa2-psk' &&
            field('passphrase', 'Passphrase', '8 to 63 characters', true)}
        </div>
      </Section>
      <div className="flex items-center justify-end gap-1.5 px-3 pb-3">
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
