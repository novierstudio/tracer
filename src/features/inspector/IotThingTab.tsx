import { useId, useState, type FormEvent } from 'react';
import { useThingStatus } from '@/features/simulation/wirelessStatus';
import { THING_TYPES, thingState, type Device, type IotConfig, type IotServer } from '@/model';
import { editorStore } from '@/model/store';
import { Button } from '@/ui/button';
import { Segmented } from '@/ui/segmented';
import { Field } from './Field';
import { HostAddressForm } from './HostAddressForm';
import { parseOptionalAddress } from './ipv4';
import { Section } from './parts';

type Thing = Extract<Device, { kind: 'pc' }>;

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

function setIot(device: Thing, iot: IotConfig) {
  editorStore.getState().updateConfig({
    device: device.id,
    kind: 'pc',
    config: { ...device.config, iot },
  });
}

const PHASE_LABELS = {
  unregistered: 'Not registered',
  registering: 'Registering…',
  registered: 'Registered',
} as const;

/** Where the thing registers: nowhere, its Home Gateway, or a remote IoT server. */
function ServerForm({ device, iot }: { device: Thing; iot: IotConfig }) {
  const id = useId();
  const status = useThingStatus(device.id);
  const current = iot.server;
  const initial = {
    mode: current.mode,
    address: current.mode === 'remote' ? current.address : '',
    username: current.mode === 'remote' ? current.username : '',
    password: current.mode === 'remote' ? current.password : '',
  };
  const [draft, setDraft] = useState<typeof initial | null>(null);
  const [error, setError] = useState<string>();
  const form = draft ?? initial;
  const edit = (patch: Partial<typeof initial>) => {
    setDraft({ ...form, ...patch });
    setError(undefined);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    let server: IotServer;
    if (form.mode === 'remote') {
      const address = parseOptionalAddress(form.address);
      if (!address.ok || !address.value) {
        setError(address.ok ? 'Enter the IoT server’s address' : address.error);
        return;
      }
      server = {
        mode: 'remote',
        address: address.value,
        username: form.username,
        password: form.password,
      };
    } else {
      server = { mode: form.mode };
    }
    setIot(device, { ...iot, server });
    setDraft(null);
  };

  return (
    <form aria-label="IoT server" onSubmit={submit} className="flex flex-col gap-2.5">
      <Segmented
        label="IoT server"
        value={form.mode}
        onValueChange={(mode) => edit({ mode })}
        options={[
          { value: 'none', label: 'None' },
          { value: 'gateway', label: 'Home Gateway' },
          { value: 'remote', label: 'Remote Server' },
        ]}
        className="self-start"
      />
      {form.mode === 'remote' && (
        <div className="grid grid-cols-2 gap-x-2 gap-y-2.5">
          <Field
            id={`${id}-address`}
            label="Server address"
            value={form.address}
            error={error}
            placeholder="10.0.0.10"
            onChange={(address) => edit({ address })}
          />
          <span />
          <Field
            id={`${id}-username`}
            label="User name"
            value={form.username}
            error={undefined}
            inputMode="text"
            onChange={(username) => edit({ username })}
          />
          <Field
            id={`${id}-password`}
            label="Password"
            value={form.password}
            error={undefined}
            inputMode="text"
            onChange={(password) => edit({ password })}
          />
        </div>
      )}
      <div className="flex items-center justify-between gap-1.5">
        <p role="status" aria-label="Registration" className="text-xs text-fg-2">
          {status
            ? `${PHASE_LABELS[status.phase]}${status.server ? ` with ${status.server}` : ''}`
            : 'Off'}
        </p>
        <span className="flex gap-1.5">
          <Button size="sm" variant="ghost" onClick={() => setDraft(null)} disabled={!draft}>
            Revert
          </Button>
          <Button size="sm" variant="primary" type="submit" disabled={!draft}>
            Apply
          </Button>
        </span>
      </div>
    </form>
  );
}

/**
 * Each attribute's state, which the thing reports to its server. A sensor changes only here, as
 * Packet Tracer's Alt-click does; an actuator also takes the server's orders.
 */
function StateControls({ device, iot }: { device: Thing; iot: IotConfig }) {
  const state = thingState(iot);
  return (
    <div className="flex flex-col gap-2.5">
      {THING_TYPES[iot.thing].attributes.map((attribute) => (
        <div key={attribute.key} className="flex items-center justify-between gap-2">
          <span className="text-xs text-fg-2">
            {attribute.label}
            {attribute.role === 'sensor' && <span className="text-fg-3"> (sensor)</span>}
          </span>
          <Segmented
            label={attribute.label}
            value={state[attribute.key]!}
            onValueChange={(value) =>
              setIot(device, { ...iot, state: { ...state, [attribute.key]: value } })
            }
            options={attribute.values.map((value) => ({ value, label: capitalize(value) }))}
          />
        </div>
      ))}
    </div>
  );
}

/** An IoT thing's Config tab: its IoT server, its state, and its IP settings. */
export function IotThingTab({ device, iot }: { device: Thing; iot: IotConfig }) {
  return (
    <>
      <Section title="IoT server">
        <ServerForm key={JSON.stringify(iot.server)} device={device} iot={iot} />
      </Section>
      <Section title={THING_TYPES[iot.thing].label} className="border-t border-line">
        <StateControls device={device} iot={iot} />
      </Section>
      <Section title="IP configuration" className="border-t border-line">
        <HostAddressForm key={device.id} device={device} />
      </Section>
    </>
  );
}
