import { ChevronRightIcon } from 'lucide-react';
import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { CLOCK_RATES, type IosDevice } from '@/cli';
import {
  err,
  formatSubnetMask,
  ok,
  type InterfaceId,
  type Port,
  type PortId,
  type Result,
} from '@/model';
import { Button } from '@/ui/button';
import { cn } from '@/ui/cn';
import { Field } from '../Field';
import { classfulMask, formatCidr, parseInterfaceAddress, type AddressErrors } from '../ipv4';
import { Mono, StateDot } from '../parts';
import { shortPortName, type PortRow } from '../view';
import { ConfigSection, inputClass, IosPreview, Select, Toggle } from './controls';
import { useSectionIos, type SectionIos } from './ios';
import { interfaceLines, type InterfaceSettings } from './lines';

type Entry = {
  id: InterfaceId;
  port: Port | undefined;
  settings: InterfaceSettings;
  /** Takes an IP address: router ports, loopbacks and VLAN interfaces. */
  routed: boolean;
};

const numberOf = (id: string) => Number(/\d+$/.exec(id)?.[0]);

/** Running-config order: loopbacks, then ports as the hardware lists them, then VLAN interfaces. */
function entriesOf(device: IosDevice): Entry[] {
  const virtual = Object.entries(device.config.virtualInterfaces)
    .map(([id, settings]) => ({ id: id as InterfaceId, port: undefined, settings, routed: true }))
    .sort((a, b) => numberOf(a.id) - numberOf(b.id));
  const ports = device.ports.flatMap((port): Entry[] => {
    const settings: InterfaceSettings | undefined = device.config.interfaces[port.id];
    return settings ? [{ id: port.id, port, settings, routed: device.kind === 'router' }] : [];
  });
  return [
    ...virtual.filter((entry) => entry.id.startsWith('Loopback')),
    ...ports,
    ...virtual.filter((entry) => entry.id.startsWith('Vlan')),
  ];
}

const shortName = (id: InterfaceId) => shortPortName(id as PortId);

export function InterfacesSection({ device, rows }: { device: IosDevice; rows: PortRow[] }) {
  const ios = useSectionIos(device.id);
  const [open, setOpen] = useState<InterfaceId>();
  // The preview sits under the interface that last changed, not at the end of a long list.
  const [active, setActive] = useState<InterfaceId>();
  const entries = entriesOf(device);
  const up = entries.filter((entry) => !entry.settings.shutdown).length;

  return (
    <ConfigSection title="Interfaces" summary={`${up} of ${entries.length} up`}>
      <ul aria-label="Interface settings" className="-mx-3 flex flex-col">
        {entries.map((entry) => (
          <InterfaceItem
            key={entry.id}
            entry={entry}
            state={rows.find((row) => row.id === entry.id)?.state}
            open={open === entry.id}
            onOpen={(next) => setOpen(next ? entry.id : undefined)}
            ios={ios}
            onActivity={() => setActive(entry.id)}
            preview={
              active === entry.id && <IosPreview ios={ios} hostname={device.config.hostname} />
            }
          />
        ))}
      </ul>
    </ConfigSection>
  );
}

function InterfaceItem({
  entry,
  state,
  open,
  onOpen,
  ios,
  onActivity,
  preview,
}: {
  entry: Entry;
  state: PortRow['state'] | undefined;
  open: boolean;
  onOpen: (open: boolean) => void;
  ios: SectionIos;
  onActivity: () => void;
  preview: ReactNode;
}) {
  const { id, settings } = entry;
  const short = shortName(id);
  const [error, setError] = useState<string>();
  const bodyId = useId();

  return (
    <li aria-label={short} className={cn('border-t border-line/70', open && 'bg-surface-2/50')}>
      <div className="flex h-8 items-center gap-2 pr-3 pl-1.5">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          aria-label={`Edit ${short}`}
          onClick={() => onOpen(!open)}
          className="flex h-7 min-w-0 flex-1 cursor-default items-center gap-2 rounded-md px-1.5 text-left text-xs outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-accent/25"
        >
          <ChevronRightIcon
            aria-hidden="true"
            className={cn(
              'size-3 shrink-0 text-fg-3 transition-transform duration-150',
              open && 'rotate-90',
            )}
          />
          <span className="flex w-[4.25rem] shrink-0 items-center gap-1.5" title={id}>
            {state ? <StateDot state={state} /> : <span aria-hidden="true" className="w-2" />}
            <Mono className="font-medium text-fg-1">{short}</Mono>
          </span>
          <Summary entry={entry} />
        </button>
        <Toggle
          label={`${short} enabled`}
          title={settings.shutdown ? 'shutdown' : 'no shutdown'}
          checked={!settings.shutdown}
          onChange={(on) => {
            onActivity();
            setError(ios.commit(interfaceLines(id, settings, { ...settings, shutdown: !on })));
          }}
        />
      </div>
      {error && !open && (
        <p role="alert" className="px-3 pb-2 text-2xs text-err">
          {error}
        </p>
      )}
      {open && (
        <div id={bodyId} className="px-3 pb-3">
          <InterfaceForm
            key={JSON.stringify(formFrom(settings))}
            entry={entry}
            ios={ios}
            onActivity={onActivity}
            onDone={() => onOpen(false)}
          />
        </div>
      )}
      {preview && <div className="px-3 pb-3">{preview}</div>}
    </li>
  );
}

function Summary({ entry }: { entry: Entry }) {
  const { settings, routed } = entry;
  return (
    <span className="flex min-w-0 flex-1 items-baseline gap-2">
      {routed &&
        (settings.ipv4 ? (
          <Mono className="shrink-0 text-fg-1">{formatCidr(settings.ipv4)}</Mono>
        ) : (
          <span className="shrink-0 text-fg-3">No address</span>
        ))}
      {settings.description && (
        <span className="truncate text-fg-2" title={settings.description}>
          {settings.description}
        </span>
      )}
    </span>
  );
}

type Form = {
  description: string;
  address: string;
  mask: string;
  speed: string;
  duplex: string;
  clockRate: string;
};

type FormErrors = AddressErrors & { description?: string; form?: string };

function formFrom(settings: InterfaceSettings): Form {
  return {
    description: settings.description ?? '',
    address: settings.ipv4?.address ?? '',
    mask: settings.ipv4 ? formatSubnetMask(settings.ipv4.prefixLength) : '',
    speed: String(settings.speed ?? 'auto'),
    duplex: settings.duplex ?? 'auto',
    clockRate: String(settings.clockRate ?? ''),
  };
}

const DESCRIPTION_MAX = 240;

function parseForm(entry: Entry, form: Form): Result<InterfaceSettings, FormErrors> {
  const { settings, routed, port } = entry;
  const description = form.description.trim();
  const address = routed ? parseInterfaceAddress(form.address, form.mask) : ok(settings.ipv4);
  const errors: FormErrors = {
    ...(address.ok ? {} : address.error),
    ...(description.length > DESCRIPTION_MAX && {
      description: `At most ${DESCRIPTION_MAX} characters`,
    }),
  };
  if (!address.ok || Object.keys(errors).length > 0) return err(errors);

  const next: InterfaceSettings = { shutdown: settings.shutdown };
  if (description) next.description = description;
  if (address.value) next.ipv4 = address.value;
  if (port && port.kind !== 'serial') {
    if (form.speed !== 'auto') next.speed = Number(form.speed) as 10 | 100 | 1000;
    if (form.duplex !== 'auto') next.duplex = form.duplex as 'full' | 'half';
  }
  if (port?.kind === 'serial' && form.clockRate) next.clockRate = Number(form.clockRate);
  return ok(next);
}

const formatRate = (rate: number) =>
  rate >= 1_000_000
    ? `${rate / 1_000_000} Mbit/s`
    : rate >= 1000
      ? `${rate / 1000} kbit/s`
      : `${rate} bit/s`;

/** Description, address, speed and duplex or clock rate, applied together as one undo step. */
function InterfaceForm({
  entry,
  ios,
  onActivity,
  onDone,
}: {
  entry: Entry;
  ios: SectionIos;
  onActivity: () => void;
  onDone: () => void;
}) {
  const { id, port, routed, settings } = entry;
  const [form, setForm] = useState(() => formFrom(settings));
  const [errors, setErrors] = useState<FormErrors>({});
  const formId = useId();
  const dirty = JSON.stringify(form) !== JSON.stringify(formFrom(settings));

  const edit = (patch: Partial<Form>) => {
    const next = { ...form, ...patch };
    setForm(next);
    setErrors({});
    onActivity();
    const parsed = parseForm(entry, next);
    ios.setPending(parsed.ok ? interfaceLines(id, settings, parsed.value) : undefined);
  };

  const revert = () => {
    setForm(formFrom(settings));
    setErrors({});
    ios.setPending(undefined);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = parseForm(entry, form);
    if (!parsed.ok) return setErrors(parsed.error);
    onActivity();
    const refused = ios.commit(interfaceLines(id, settings, parsed.value));
    if (refused) setErrors({ form: refused });
  };

  const ethernet = port !== undefined && port.kind !== 'serial';
  const serial = port?.kind === 'serial';

  return (
    <form
      aria-label={`${shortName(id)} settings`}
      onSubmit={submit}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        if (dirty) revert();
        else onDone();
      }}
      className="flex flex-col gap-2.5 pt-1"
    >
      <div className="flex flex-col gap-1">
        <label htmlFor={`${formId}-description`} className="text-2xs text-fg-3">
          Description
        </label>
        <input
          id={`${formId}-description`}
          value={form.description}
          placeholder="Link to SW1"
          spellCheck={false}
          autoComplete="off"
          aria-invalid={errors.description !== undefined}
          onChange={(event) => edit({ description: event.target.value })}
          className={inputClass(false, errors.description !== undefined)}
        />
        {errors.description && <p className="text-2xs text-err">{errors.description}</p>}
      </div>
      {routed && (
        <div className="grid grid-cols-2 gap-2">
          <Field
            id={`${formId}-address`}
            label="IP address"
            value={form.address}
            error={errors.address}
            placeholder="192.168.1.1"
            onChange={(address) => edit({ address })}
          />
          <Field
            id={`${formId}-mask`}
            label="Subnet mask"
            value={form.mask}
            error={errors.mask}
            placeholder={classfulMask(form.address) ?? '255.255.255.0'}
            onChange={(mask) => edit({ mask })}
          />
        </div>
      )}
      {ethernet && (
        <div className="grid grid-cols-2 gap-2">
          <LabelledSelect
            id={`${formId}-speed`}
            label="Speed"
            value={form.speed}
            onChange={(speed) => edit({ speed })}
            options={[
              ['auto', 'Auto'],
              ['10', '10 Mbit/s'],
              ['100', '100 Mbit/s'],
              ...(port.kind === 'gigabitEthernet' ? [['1000', '1000 Mbit/s'] as const] : []),
            ]}
          />
          <LabelledSelect
            id={`${formId}-duplex`}
            label="Duplex"
            value={form.duplex}
            onChange={(duplex) => edit({ duplex })}
            options={[
              ['auto', 'Auto'],
              ['full', 'Full'],
              ['half', 'Half'],
            ]}
          />
        </div>
      )}
      {serial && routed && (
        <LabelledSelect
          id={`${formId}-clock`}
          label="Clock rate (DCE end)"
          value={form.clockRate}
          onChange={(clockRate) => edit({ clockRate })}
          options={[
            ['', 'None'],
            ...[...CLOCK_RATES].map((rate) => [String(rate), formatRate(rate)] as const),
          ]}
        />
      )}
      {errors.form && (
        <p role="alert" className="text-2xs text-err">
          {errors.form}
        </p>
      )}
      <div className="flex items-center justify-end gap-1.5">
        <Button size="sm" variant="ghost" onClick={revert} disabled={!dirty}>
          Revert
        </Button>
        <Button size="sm" variant="primary" type="submit" disabled={!dirty}>
          Apply
        </Button>
      </div>
    </form>
  );
}

function LabelledSelect({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  options: readonly (readonly [value: string, label: string])[];
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-2xs text-fg-3">
        {label}
      </label>
      <Select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map(([option, text]) => (
          <option key={option} value={option}>
            {text}
          </option>
        ))}
      </Select>
    </div>
  );
}
