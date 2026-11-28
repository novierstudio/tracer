import { PlusIcon, XIcon } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { DomainName, Ipv4Address, serverServices, type Device, type ServerServices } from '@/model';
import { editorStore } from '@/model/store';
import { Button } from '@/ui/button';
import { cn } from '@/ui/cn';
import { useServerStatus } from '@/features/simulation/serverStatus';
import { ConfigSection, inputClass } from './config/controls';
import { MailDomain, MailUsers } from './services/Email';
import { FileList } from './services/FileList';
import { FtpUsers } from './services/FtpUsers';
import { NtpClock } from './services/NtpClock';
import { firstIssue, onOff, ServiceSwitch } from './services/parts';
import { SyslogTable } from './services/SyslogTable';

type Server = Extract<Device, { kind: 'server' }>;

/**
 * A server's services, in Packet Tracer's order. Every change is one undo step in the server's
 * config. Syslog messages and mailbox counts are live state, from the simulation.
 */
export function ServicesTab({ device }: { device: Server }) {
  const services = serverServices(device.config);
  const { tftp, ftp, email, ntp, iot } = services;
  const status = useServerStatus(device.id);
  const write = (next: ServerServices) =>
    editorStore.getState().updateConfig({
      device: device.id,
      kind: 'server',
      config: { ...device.config, services: next },
    });
  return (
    <>
      <ConfigSection title="HTTP" summary={onOff(services.http.enabled)}>
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
      <ConfigSection title="TFTP" summary={onOff(tftp.enabled)}>
        <ServiceSwitch
          label="TFTP service"
          checked={tftp.enabled}
          onChange={(enabled) => write({ ...services, tftp: { ...tftp, enabled } })}
        />
        <FileList
          label="TFTP files"
          testId="tftp-files"
          files={tftp.files}
          onChange={(files) => write({ ...services, tftp: { ...tftp, files } })}
        />
      </ConfigSection>
      <ConfigSection title="DNS" summary={onOff(services.dns.enabled)}>
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
      <ConfigSection title="SYSLOG" summary={onOff(services.syslog.enabled)}>
        <ServiceSwitch
          label="Syslog service"
          checked={services.syslog.enabled}
          onChange={(enabled) => write({ ...services, syslog: { enabled } })}
        />
        <SyslogTable entries={status?.syslog ?? []} />
      </ConfigSection>
      <ConfigSection title="NTP" summary={onOff(ntp.enabled)}>
        <ServiceSwitch
          label="NTP service"
          checked={ntp.enabled}
          onChange={(enabled) => write({ ...services, ntp: { ...ntp, enabled } })}
        />
        <NtpClock
          epoch={ntp.epoch}
          onSet={(epoch) => write({ ...services, ntp: { ...ntp, epoch } })}
        />
      </ConfigSection>
      <ConfigSection title="EMAIL" summary={onOff(email.smtp || email.pop3)}>
        <ServiceSwitch
          label="SMTP service"
          rowLabel="SMTP Service"
          checked={email.smtp}
          onChange={(smtp) => write({ ...services, email: { ...email, smtp } })}
        />
        <ServiceSwitch
          label="POP3 service"
          rowLabel="POP3 Service"
          checked={email.pop3}
          onChange={(pop3) => write({ ...services, email: { ...email, pop3 } })}
        />
        <MailDomain
          domain={email.domain}
          onSet={(domain) => write({ ...services, email: { ...email, domain } })}
        />
        <MailUsers
          users={email.users}
          mailboxes={status?.mailboxes}
          onChange={(users) => write({ ...services, email: { ...email, users } })}
        />
      </ConfigSection>
      <ConfigSection title="FTP" summary={onOff(ftp.enabled)}>
        <ServiceSwitch
          label="FTP service"
          checked={ftp.enabled}
          onChange={(enabled) => write({ ...services, ftp: { ...ftp, enabled } })}
        />
        <FtpUsers
          users={ftp.users}
          onChange={(users) => write({ ...services, ftp: { ...ftp, users } })}
        />
        <FileList
          label="FTP files"
          testId="ftp-files"
          files={ftp.files}
          onChange={(files) => write({ ...services, ftp: { ...ftp, files } })}
        />
      </ConfigSection>
      <ConfigSection title="IoT" summary={onOff(iot.enabled)}>
        <ServiceSwitch
          label="IoT service"
          checked={iot.enabled}
          onChange={(enabled) => write({ ...services, iot: { ...iot, enabled } })}
        />
        <p className="text-2xs text-fg-3">
          The registration server things set to Remote Server register with, under an account here.
          Browse to this server to sign in and control them. Its page replaces the HTTP page while
          IoT is on.
        </p>
        <MailUsers
          noun="IoT"
          users={iot.users}
          mailboxes={null}
          onChange={(users) => write({ ...services, iot: { ...iot, users } })}
        />
      </ConfigSection>
    </>
  );
}

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
