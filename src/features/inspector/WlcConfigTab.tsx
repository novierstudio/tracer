import { Trash2Icon } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { findDeviceModel } from '@/devices/catalog';
import { useLapStatus, useWlcStatus } from '@/features/simulation/wirelessStatus';
import {
  formatSubnetMask,
  Ssid,
  VlanId,
  WirelessSecurity,
  type Device,
  type HostIpv4,
  type Wlan,
} from '@/model';
import { editorStore } from '@/model/store';
import { Button } from '@/ui/button';
import { Segmented } from '@/ui/segmented';
import { Tooltip } from '@/ui/tooltip';
import { Field } from './Field';
import { parseInterfaceAddress, parseOptionalAddress } from './ipv4';
import { Facts, Mono, Section } from './parts';

type Controller = Extract<Device, { kind: 'wlc' }>;

const firstIssue = (error: { issues: readonly { message: string }[] }) =>
  error.issues[0]?.message ?? 'Invalid value';

const SECURITY_LABELS: Record<WirelessSecurity['mode'], string> = {
  none: 'Open',
  'wpa2-psk': 'WPA2 Personal',
};

const modelName = (model: string) => findDeviceModel(model)?.name ?? model;

function setConfig(device: Controller, config: Partial<Controller['config']>) {
  editorStore.getState().updateConfig({
    device: device.id,
    kind: 'wlc',
    config: { ...device.config, ...config },
  });
}

/** The management interface: the address lightweight APs join over CAPWAP. */
function ManagementForm({ device }: { device: Controller }) {
  const id = useId();
  const current = device.config.management;
  const initial = {
    address: current.mode === 'static' ? (current.address?.address ?? '') : '',
    mask:
      current.mode === 'static' && current.address
        ? formatSubnetMask(current.address.prefixLength)
        : '',
    gateway: current.mode === 'static' ? (current.gateway ?? '') : '',
  };
  const [draft, setDraft] = useState<typeof initial | null>(null);
  const [errors, setErrors] = useState<Partial<Record<keyof typeof initial, string>>>({});
  const form = draft ?? initial;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const address = parseInterfaceAddress(form.address, form.mask);
    const gateway = parseOptionalAddress(form.gateway);
    if (!address.ok || !gateway.ok) {
      setErrors({
        ...(!address.ok && address.error),
        ...(!gateway.ok && { gateway: gateway.error }),
      });
      return;
    }
    const management: HostIpv4 = { mode: 'static' };
    if (address.value) management.address = address.value;
    if (gateway.value) management.gateway = gateway.value;
    setConfig(device, { management });
    setDraft(null);
    setErrors({});
  };

  const field = (key: keyof typeof initial, label: string, placeholder: string) => (
    <Field
      id={`${id}-${key}`}
      label={label}
      value={form[key]}
      error={errors[key]}
      placeholder={placeholder}
      onChange={(value) => {
        setDraft({ ...form, [key]: value });
        setErrors((current) => ({ ...current, [key]: undefined }));
      }}
    />
  );

  return (
    <form aria-label="Management interface" onSubmit={submit} className="flex flex-col gap-2.5">
      <div className="grid grid-cols-2 gap-x-2 gap-y-2.5">
        {field('address', 'Management IP', '192.168.10.2')}
        {field('mask', 'Subnet mask', '255.255.255.0')}
        {field('gateway', 'Default gateway', '192.168.10.1')}
      </div>
      <div className="flex justify-end gap-1.5">
        <Button size="sm" variant="ghost" onClick={() => setDraft(null)} disabled={!draft}>
          Revert
        </Button>
        <Button size="sm" variant="primary" type="submit" disabled={!draft}>
          Apply
        </Button>
      </div>
    </form>
  );
}

type WlanForm = {
  ssid: string;
  security: WirelessSecurity['mode'];
  passphrase: string;
  vlan: string;
};
const EMPTY_WLAN: WlanForm = { ssid: '', security: 'wpa2-psk', passphrase: '', vlan: '' };

/** Adds a WLAN: its SSID, security and the VLAN its clients belong to. */
function NewWlan({ device }: { device: Controller }) {
  const id = useId();
  const [form, setForm] = useState<WlanForm>(EMPTY_WLAN);
  const [errors, setErrors] = useState<Partial<Record<keyof WlanForm, string>>>({});
  const edit = (patch: Partial<WlanForm>) => {
    setForm({ ...form, ...patch });
    setErrors({});
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const found: Partial<Record<keyof WlanForm, string>> = {};
    const ssid = Ssid.safeParse(form.ssid.trim());
    if (!ssid.success) found.ssid = firstIssue(ssid.error);
    else if (device.config.wlans.some((wlan) => wlan.ssid === ssid.data)) {
      found.ssid = `${ssid.data} is already a WLAN`;
    }
    const security = WirelessSecurity.safeParse(
      form.security === 'none'
        ? { mode: 'none' }
        : { mode: form.security, passphrase: form.passphrase },
    );
    if (!security.success) found.passphrase = firstIssue(security.error);
    const vlan = form.vlan.trim() === '' ? undefined : VlanId.safeParse(Number(form.vlan));
    if (vlan && !vlan.success) found.vlan = 'Enter a VLAN from 1 to 4094';
    if (!ssid.success || !security.success || (vlan && !vlan.success) || found.ssid) {
      setErrors(found);
      return;
    }
    const wlan: Wlan = {
      ssid: ssid.data,
      security: security.data,
      enabled: true,
      ...(vlan?.success && { vlan: vlan.data }),
    };
    setConfig(device, { wlans: [...device.config.wlans, wlan] });
    setForm(EMPTY_WLAN);
  };

  return (
    <form aria-label="New WLAN" onSubmit={submit} className="flex flex-col gap-2.5">
      <div className="grid grid-cols-2 gap-x-2 gap-y-2.5">
        <Field
          id={`${id}-ssid`}
          label="SSID"
          value={form.ssid}
          error={errors.ssid}
          placeholder="Corp"
          inputMode="text"
          onChange={(ssid) => edit({ ssid })}
        />
        <Field
          id={`${id}-vlan`}
          label="VLAN (blank: management)"
          value={form.vlan}
          error={errors.vlan}
          placeholder="10"
          inputMode="numeric"
          onChange={(vlan) => edit({ vlan })}
        />
      </div>
      <Segmented
        label="Security"
        value={form.security}
        onValueChange={(security) => edit({ security })}
        options={[
          { value: 'none', label: 'Open' },
          { value: 'wpa2-psk', label: 'WPA2 Personal' },
        ]}
        className="self-start"
      />
      {form.security === 'wpa2-psk' && (
        <Field
          id={`${id}-passphrase`}
          label="Passphrase"
          value={form.passphrase}
          error={errors.passphrase}
          placeholder="8 to 63 characters"
          inputMode="text"
          onChange={(passphrase) => edit({ passphrase })}
        />
      )}
      <Button size="sm" type="submit" className="self-end">
        Add WLAN
      </Button>
    </form>
  );
}

function WlanList({ device }: { device: Controller }) {
  const { wlans } = device.config;
  if (wlans.length === 0) return <p className="text-xs text-fg-3">No WLANs yet.</p>;
  const replace = (index: number, wlan: Wlan | undefined) =>
    setConfig(device, {
      wlans: wlan
        ? wlans.map((other, at) => (at === index ? wlan : other))
        : wlans.filter((_, at) => at !== index),
    });
  return (
    <ul aria-label="WLANs" className="flex flex-col gap-1.5">
      {wlans.map((wlan, index) => (
        <li
          key={wlan.ssid}
          className="flex items-center gap-2 rounded-lg border border-line bg-surface-1 px-2.5 py-1.5"
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs font-medium text-fg-1">
              {index + 1}. {wlan.ssid}
            </span>
            <span className="block text-2xs text-fg-3">
              {SECURITY_LABELS[wlan.security.mode]} ·{' '}
              {wlan.vlan === undefined ? 'management' : `VLAN ${wlan.vlan}`}
            </span>
          </span>
          <label className="flex items-center gap-1 text-2xs text-fg-2">
            <input
              type="checkbox"
              checked={wlan.enabled}
              onChange={(event) => replace(index, { ...wlan, enabled: event.target.checked })}
            />
            Enabled
          </label>
          <Tooltip label={`Remove ${wlan.ssid}`}>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={`Remove ${wlan.ssid}`}
              onClick={() => replace(index, undefined)}
            >
              <Trash2Icon />
            </Button>
          </Tooltip>
        </li>
      ))}
    </ul>
  );
}

function ApList({ device }: { device: Controller }) {
  const status = useWlcStatus(device.id);
  const aps = status?.aps ?? [];
  if (aps.length === 0) {
    return <p className="text-xs text-fg-3">No access points have joined.</p>;
  }
  return (
    <table aria-label="Access points" className="w-full text-left text-xs">
      <thead className="text-2xs text-fg-3">
        <tr>
          <th className="font-normal">AP name</th>
          <th className="font-normal">Model</th>
          <th className="font-normal">IP address</th>
        </tr>
      </thead>
      <tbody>
        {aps.map((ap) => (
          <tr key={ap.address}>
            <td className="py-0.5 text-fg-1">{ap.name}</td>
            <td className="text-fg-2">{modelName(ap.model)}</td>
            <td>
              <Mono>{ap.address}</Mono>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * A wireless LAN controller's web GUI, as Packet Tracer's has it: the management interface, the
 * WLANs its lightweight APs broadcast, and the APs that have joined it.
 */
export function WlcConfigTab({ device }: { device: Controller }) {
  return (
    <>
      <Section title="Management interface">
        <ManagementForm key={JSON.stringify(device.config.management)} device={device} />
      </Section>
      <Section title="WLANs" className="border-t border-line">
        <div className="flex flex-col gap-3">
          <WlanList device={device} />
          <NewWlan device={device} />
        </div>
      </Section>
      <Section title="Access points" className="border-t border-line">
        <ApList device={device} />
      </Section>
    </>
  );
}

const PHASE_LABELS = {
  idle: 'Waiting for an address by DHCP',
  discovering: 'Looking for a controller',
  joining: 'Joining its controller',
  joined: 'Joined',
} as const;

/** A lightweight AP has nothing to set: it shows what DHCP and its controller gave it. */
export function LapStatusTab({ device }: { device: Extract<Device, { kind: 'lightweightAp' }> }) {
  const status = useLapStatus(device.id);
  return (
    <Section title="Lightweight AP">
      <div className="flex flex-col gap-2">
        <p className="text-xs text-fg-2">
          A lightweight AP takes its address by DHCP, finds a wireless LAN controller through DHCP
          option 43 or on its own subnet, and joins it over CAPWAP. It then broadcasts the
          controller’s WLANs.
        </p>
        <Facts
          rows={[
            ['Status', status ? PHASE_LABELS[status.phase] : 'Off'],
            ['IP address', status?.address ? <Mono>{status.address}</Mono> : 'None'],
            [
              'Controller',
              status?.controller ? (
                <Mono>{`${status.controller.name} (${status.controller.address})`}</Mono>
              ) : (
                'None'
              ),
            ],
            [
              'WLANs',
              status && status.wlans.length > 0
                ? status.wlans.map((wlan) => wlan.ssid).join(', ')
                : 'None',
            ],
          ]}
        />
      </div>
    </Section>
  );
}
