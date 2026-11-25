import { XIcon } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import type { SwitchDevice } from '@/cli';
import { err, ok, VlanId, type PortId, type Result } from '@/model';
import { Button } from '@/ui/button';
import { Field } from '../Field';
import { Mono } from '../parts';
import { shortPortName } from '../view';
import { ConfigSection, inputClass, IosPreview, Select, useTextDraft } from './controls';
import { useSectionIos, type SectionIos } from './ios';
import {
  membershipOf,
  removeVlanLines,
  switchportLines,
  vlanLines,
  type PortMembership,
} from './lines';

const VLAN_NAME = /^\S{1,32}$/;
const NAME_RULE = 'One word of up to 32 characters. Use - or _ instead of spaces';

function parseName(text: string): Result<string | undefined, string> {
  const name = text.trim();
  if (name === '') return ok(undefined);
  return VLAN_NAME.test(name) ? ok(name) : err(NAME_RULE);
}

type NewVlan = { id: string; name: string };
type NewVlanErrors = Partial<Record<keyof NewVlan, string>>;

function parseNewVlan(
  form: NewVlan,
  vlans: SwitchDevice['config']['vlans'],
): Result<{ id: VlanId; name: string | undefined }, NewVlanErrors> {
  const errors: NewVlanErrors = {};
  const text = form.id.trim();
  const id = /^\d+$/.test(text) ? VlanId.safeParse(Number(text)) : undefined;
  if (!text) errors.id = 'Enter a VLAN ID';
  else if (!id?.success) errors.id = 'VLAN ID must be between 1 and 4094';
  else if (id.data in vlans) errors.id = `VLAN ${id.data} already exists`;
  const name = parseName(form.name);
  if (!name.ok) errors.name = name.error;
  if (!id?.success || !name.ok || Object.keys(errors).length > 0) return err(errors);
  return ok({ id: id.data, name: name.value });
}

const vlanIds = (device: SwitchDevice) =>
  (Object.keys(device.config.vlans).map(Number) as VlanId[]).sort((a, b) => a - b);

export function VlansSection({ device }: { device: SwitchDevice }) {
  const { vlans, interfaces } = device.config;
  const ios = useSectionIos(device.id);
  // The preview sits under the VLAN list or under the port that last changed.
  const [active, setActive] = useState<'vlans' | PortId>('vlans');
  const ids = vlanIds(device);
  const ports = device.ports.flatMap((port) => {
    const settings = interfaces[port.id];
    return settings ? [{ id: port.id, membership: membershipOf(settings.switchport) }] : [];
  });
  const members = (vlan: VlanId) =>
    ports.filter(({ membership }) => membership.mode === 'access' && membership.vlan === vlan)
      .length;
  const preview = <IosPreview ios={ios} hostname={device.config.hostname} />;

  return (
    <ConfigSection title="VLANs" summary={String(ids.length)}>
      <ul aria-label="VLANs" className="flex flex-col rounded-md border border-line">
        {ids.map((vlan) => (
          <VlanItem
            key={vlan}
            vlan={vlan}
            name={vlans[vlan]?.name ?? ''}
            members={members(vlan)}
            ios={ios}
            onActivity={() => setActive('vlans')}
          />
        ))}
      </ul>
      <AddVlanForm device={device} ios={ios} onActivity={() => setActive('vlans')} />
      {active === 'vlans' && preview}

      <div className="flex items-center gap-2 pt-1.5 text-2xs text-fg-3">
        <h4 className="w-14 shrink-0 font-medium">Port</h4>
        <span className="w-[5.25rem] shrink-0">Mode</span>
        <span>VLAN / native</span>
      </div>
      <ul aria-label="Port membership" className="-mx-3 flex flex-col">
        {ports.map(({ id, membership }) => (
          <li key={id} className="flex flex-col">
            <PortMembershipRow
              device={device}
              port={id}
              membership={membership}
              vlans={ids}
              ios={ios}
              onActivity={() => setActive(id)}
            />
            {active === id && <div className="px-3 pb-2">{preview}</div>}
          </li>
        ))}
      </ul>
    </ConfigSection>
  );
}

function VlanItem({
  vlan,
  name,
  members,
  ios,
  onActivity,
}: {
  vlan: VlanId;
  name: string;
  members: number;
  ios: SectionIos;
  onActivity: () => void;
}) {
  const [removeError, setRemoveError] = useState<string>();
  const draft = useTextDraft({
    value: name,
    ios,
    plan: (text) => {
      onActivity();
      const parsed = parseName(text);
      if (!parsed.ok) return parsed;
      if (parsed.value === undefined) return err('Enter a name');
      return ok(parsed.value === name ? [] : vlanLines(vlan, parsed.value));
    },
  });
  const error = draft.error ?? removeError;
  return (
    <li
      aria-label={`VLAN ${vlan}`}
      className="flex flex-col gap-1 border-b border-line px-2 py-1 last:border-b-0"
    >
      <div className="flex items-center gap-2">
        <Mono className="w-9 shrink-0 text-fg-1">{vlan}</Mono>
        <input
          aria-label={`VLAN ${vlan} name`}
          {...draft.props}
          disabled={vlan === 1}
          className={`${inputClass(false, draft.error !== undefined)} h-6 border-transparent bg-transparent px-1.5 hover:border-line disabled:hover:border-transparent`}
        />
        <span className="shrink-0 text-2xs text-fg-3 tabular-nums">
          {members} {members === 1 ? 'port' : 'ports'}
        </span>
        {vlan === 1 ? (
          <span className="size-6 shrink-0" />
        ) : (
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={`Remove VLAN ${vlan}`}
            className="size-6 [&_svg:not([class*='size-'])]:size-3.5"
            onClick={() => {
              onActivity();
              setRemoveError(ios.commit(removeVlanLines(vlan)));
            }}
          >
            <XIcon />
          </Button>
        )}
      </div>
      {error && (
        <p id={draft.errorId} role="alert" className="pl-11 text-2xs text-err">
          {error}
        </p>
      )}
    </li>
  );
}

function AddVlanForm({
  device,
  ios,
  onActivity,
}: {
  device: SwitchDevice;
  ios: SectionIos;
  onActivity: () => void;
}) {
  const [form, setForm] = useState<NewVlan>({ id: '', name: '' });
  const [errors, setErrors] = useState<NewVlanErrors>({});
  const id = useId();

  const edit = (patch: Partial<NewVlan>) => {
    const next = { ...form, ...patch };
    setForm(next);
    setErrors({});
    onActivity();
    const parsed = parseNewVlan(next, device.config.vlans);
    ios.setPending(parsed.ok ? vlanLines(parsed.value.id, parsed.value.name) : undefined);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = parseNewVlan(form, device.config.vlans);
    if (!parsed.ok) return setErrors(parsed.error);
    const refused = ios.commit(vlanLines(parsed.value.id, parsed.value.name));
    if (refused) return setErrors({ id: refused });
    setForm({ id: '', name: '' });
  };

  return (
    <form
      aria-label="Add a VLAN"
      onSubmit={submit}
      className="grid grid-cols-[4.5rem_minmax(0,1fr)_auto] items-start gap-2"
    >
      <Field
        id={`${id}-id`}
        label="VLAN ID"
        value={form.id}
        error={errors.id}
        placeholder="10"
        onChange={(value) => edit({ id: value })}
      />
      <div className="flex min-w-0 flex-col gap-1">
        <label htmlFor={`${id}-name`} className="text-2xs text-fg-3">
          Name
        </label>
        <input
          id={`${id}-name`}
          value={form.name}
          placeholder="Sales"
          spellCheck={false}
          autoComplete="off"
          aria-invalid={errors.name !== undefined}
          onChange={(event) => edit({ name: event.target.value })}
          className={inputClass(false, errors.name !== undefined)}
        />
        {errors.name && <p className="text-2xs text-err">{errors.name}</p>}
      </div>
      <Button size="sm" type="submit" className="mt-[1.125rem]">
        Add
      </Button>
    </form>
  );
}

function PortMembershipRow({
  device,
  port,
  membership,
  vlans,
  ios,
  onActivity,
}: {
  device: SwitchDevice;
  port: PortId;
  membership: PortMembership;
  vlans: readonly VlanId[];
  ios: SectionIos;
  onActivity: () => void;
}) {
  const [error, setError] = useState<string>();
  const short = shortPortName(port);
  const before = device.config.interfaces[port]!.switchport;
  const run = (next: PortMembership) => {
    onActivity();
    setError(ios.commit(switchportLines(port, before, next)));
  };
  // Switching mode brings back the VLAN that mode last had, as IOS does.
  const vlanFor = (mode: PortMembership['mode']) =>
    mode === 'access'
      ? before.mode === 'access'
        ? before.vlan
        : (before.accessVlan ?? VlanId.parse(1))
      : (before.nativeVlan ?? VlanId.parse(1));
  const options = vlans.includes(membership.vlan) ? vlans : [...vlans, membership.vlan];
  const vlanLabel = membership.mode === 'access' ? `${short} access VLAN` : `${short} native VLAN`;

  return (
    <div className="flex flex-col border-t border-line/70 px-3 py-0.5">
      <div className="flex items-center gap-2">
        <Mono className="w-14 shrink-0 font-medium text-fg-1">{short}</Mono>
        <Select
          aria-label={`${short} mode`}
          value={membership.mode}
          onChange={(event) => {
            const mode = event.target.value as PortMembership['mode'];
            run({ mode, vlan: vlanFor(mode) });
          }}
          className="h-6 w-[5.25rem] shrink-0"
        >
          <option value="access">Access</option>
          <option value="trunk">Trunk</option>
        </Select>
        <Select
          aria-label={vlanLabel}
          value={membership.vlan}
          onChange={(event) =>
            run({ ...membership, vlan: VlanId.parse(Number(event.target.value)) })
          }
          className="h-6 min-w-0 flex-1 font-mono text-[0.6875rem]"
        >
          {options.map((vlan) => (
            <option key={vlan} value={vlan}>
              {vlan} · {device.config.vlans[vlan]?.name ?? 'missing'}
            </option>
          ))}
        </Select>
      </div>
      {error && (
        <p role="alert" className="pt-1 text-2xs text-err">
          {error}
        </p>
      )}
    </div>
  );
}
