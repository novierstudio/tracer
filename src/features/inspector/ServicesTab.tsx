import { PlusIcon, XIcon } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { DomainName, Ipv4Address, serverServices, type Device, type ServerServices } from '@/model';
import { editorStore } from '@/model/store';
import { Button } from '@/ui/button';
import { cn } from '@/ui/cn';
import { ConfigSection, inputClass, SettingRow, Toggle } from './config/controls';

type Server = Extract<Device, { kind: 'server' }>;

/** A server's DNS and HTTP services. Every change is one undo step in the server's config. */
export function ServicesTab({ device }: { device: Server }) {
  const services = serverServices(device.config);
  const write = (next: ServerServices) =>
    editorStore.getState().updateConfig({
      device: device.id,
      kind: 'server',
      config: { ...device.config, services: next },
    });
  return (
    <>
      <ConfigSection title="DNS" summary={services.dns.enabled ? 'On' : 'Off'}>
        <ServiceSwitch
          label="DNS service"
          checked={services.dns.enabled}
          onChange={(enabled) => write({ ...services, dns: { ...services.dns, enabled } })}
        />
        <DnsRecords
          services={services}
          onChange={(records) => write({ ...services, dns: { ...services.dns, records } })}
        />
      </ConfigSection>
      <ConfigSection title="HTTP" summary={services.http.enabled ? 'On' : 'Off'}>
        <ServiceSwitch
          label="HTTP service"
          checked={services.http.enabled}
          onChange={(enabled) => write({ ...services, http: { ...services.http, enabled } })}
        />
        <IndexHtml
          key={device.id}
          html={services.http.indexHtml}
          onSave={(indexHtml) => write({ ...services, http: { ...services.http, indexHtml } })}
        />
      </ConfigSection>
    </>
  );
}

function ServiceSwitch({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <SettingRow label="Service">
      <span className="flex h-7 items-center gap-2 text-xs text-fg-2">
        <Toggle label={label} checked={checked} onChange={onChange} />
        <span aria-hidden="true">{checked ? 'On' : 'Off'}</span>
      </span>
    </SettingRow>
  );
}

const firstIssue = (error: { issues: readonly { message: string }[] }) =>
  error.issues[0]?.message ?? 'Invalid value';

type RecordErrors = { name?: string; address?: string };

/** The A records, and a row to add one. A name has one record. */
function DnsRecords({
  services,
  onChange,
}: {
  services: ServerServices;
  onChange: (records: ServerServices['dns']['records']) => void;
}) {
  const { records } = services.dns;
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [errors, setErrors] = useState<RecordErrors>({});
  const id = useId();

  const add = (event: FormEvent) => {
    event.preventDefault();
    const parsedName = DomainName.safeParse(name);
    const parsedAddress = Ipv4Address.safeParse(address.trim());
    const next: RecordErrors = {};
    if (!name.trim()) next.name = 'Type a name, such as www.lab.local';
    else if (!parsedName.success) next.name = firstIssue(parsedName.error);
    else if (records.some((record) => record.name === parsedName.data)) {
      next.name = `${parsedName.data} already has a record. Remove it first.`;
    }
    if (!address.trim()) next.address = 'Type the IPv4 address the name stands for';
    else if (!parsedAddress.success) next.address = firstIssue(parsedAddress.error);
    if (next.name || next.address || !parsedName.success || !parsedAddress.success) {
      return setErrors(next);
    }
    onChange([...records, { name: parsedName.data, address: parsedAddress.data }]);
    setName('');
    setAddress('');
    setErrors({});
  };

  const message = errors.name ?? errors.address;
  return (
    <div className="flex flex-col gap-1.5">
      <table aria-label="DNS records" className="w-full table-fixed text-xs">
        <thead>
          <tr className="text-left text-2xs text-fg-3">
            <th scope="col" className="pb-1 font-normal">
              Name
            </th>
            <th scope="col" className="w-[7.5rem] pb-1 font-normal">
              Address
            </th>
            <th scope="col" className="w-7 pb-1">
              <span className="sr-only">Remove</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {records.length === 0 && (
            <tr>
              <td colSpan={3} className="py-1 text-fg-3">
                No records yet.
              </td>
            </tr>
          )}
          {records.map((record) => (
            <tr key={record.name} className="border-t border-line">
              <td className="truncate py-1 pr-2 font-mono text-[0.6875rem] text-fg-1">
                {record.name}
              </td>
              <td className="py-1 pr-2 font-mono text-[0.6875rem] text-fg-1 tabular-nums">
                {record.address}
              </td>
              <td className="py-0.5 text-right">
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Remove ${record.name}`}
                  className="size-6"
                  onClick={() => onChange(records.filter((other) => other !== record))}
                >
                  <XIcon />
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <form aria-label="Add DNS record" onSubmit={add} className="flex flex-col gap-1">
        <div className="grid grid-cols-[minmax(0,1fr)_7.5rem_auto] items-center gap-1.5">
          <input
            aria-label="Record name"
            value={name}
            placeholder="www.lab.local"
            spellCheck={false}
            autoComplete="off"
            aria-invalid={errors.name !== undefined}
            aria-describedby={message ? `${id}-error` : undefined}
            onChange={(event) => {
              setName(event.target.value);
              setErrors(({ address: kept }) => (kept ? { address: kept } : {}));
            }}
            className={inputClass(true, errors.name !== undefined)}
          />
          <input
            aria-label="Record address"
            value={address}
            placeholder="192.168.1.20"
            spellCheck={false}
            autoComplete="off"
            inputMode="decimal"
            aria-invalid={errors.address !== undefined}
            aria-describedby={message ? `${id}-error` : undefined}
            onChange={(event) => {
              setAddress(event.target.value);
              setErrors(({ name: kept }) => (kept ? { name: kept } : {}));
            }}
            className={inputClass(true, errors.address !== undefined)}
          />
          <Button type="submit" size="sm" aria-label="Add record" className="px-1.5">
            <PlusIcon />
            Add
          </Button>
        </div>
        {message && (
          <p id={`${id}-error`} role="alert" className="text-2xs text-err">
            {message}
          </p>
        )}
      </form>
    </div>
  );
}

/** The one page the server serves. Saves on blur, Ctrl/Cmd+Enter or Save; Escape reverts. */
function IndexHtml({ html, onSave }: { html: string; onSave: (html: string) => void }) {
  // null while not editing, so undo shows through.
  const [draft, setDraft] = useState<string | null>(null);
  const id = useId();
  const save = () => {
    if (draft !== null && draft !== html) onSave(draft);
    setDraft(null);
  };
  const dirty = draft !== null && draft !== html;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-xs text-fg-3">
        index.html
      </label>
      <textarea
        id={id}
        value={draft ?? html}
        rows={12}
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={save}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            save();
          } else if (event.key === 'Escape' && draft !== null) {
            event.preventDefault();
            setDraft(null);
          }
        }}
        className={cn(inputClass(true, false), 'h-auto resize-y py-1.5 leading-4')}
      />
      <div className="flex items-center justify-between gap-1.5">
        <p className="text-2xs text-fg-3">Served at / and /index.html.</p>
        <span className="flex gap-1.5">
          <Button
            size="sm"
            variant="ghost"
            disabled={!dirty}
            // Keeps focus in the page, so its blur does not save what Revert throws away.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => setDraft(null)}
          >
            Revert
          </Button>
          <Button size="sm" variant="primary" disabled={!dirty} onClick={save}>
            Save
          </Button>
        </span>
      </div>
    </div>
  );
}
