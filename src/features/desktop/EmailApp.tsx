import { InboxIcon, MailPlusIcon, RefreshCwIcon, SendIcon, SettingsIcon } from 'lucide-react';
import { useId, useState, type FormEvent, type ReactNode } from 'react';
import type { MailAccount } from '@/model';
import { editorStore } from '@/model/store';
import { Button } from '@/ui/button';
import { cn } from '@/ui/cn';
import type { HostBackend, Mail, MailFailure } from './backend';
import type { HostDevice } from './format';
import { deliver, useInbox } from './inbox';

type View = 'inbox' | 'compose' | 'configure';

type Status = { text: string; error?: boolean };

const BLANK_ACCOUNT: MailAccount = {
  name: '',
  address: '',
  incoming: '',
  outgoing: '',
  username: '',
  password: '',
};

/** Why a send or a receive failed, after `Send Mail Failed:` or `Receive Mail Failed:`. */
function failureReason(failure: MailFailure): string {
  switch (failure.kind) {
    case 'no-dns-server':
      return 'no DNS server is set to look the server up.';
    case 'name-not-found':
      return `cannot find the server ${failure.name}.`;
    case 'dns-timeout':
      return 'the DNS server did not answer.';
    case 'refused':
      return 'the server refused the connection.';
    case 'timeout':
      return 'the server did not answer.';
    case 'reset':
      return 'the connection was reset.';
    case 'rejected':
      return failure.reply;
    case 'cancelled':
      return 'cancelled.';
  }
}

/** A mail's recipients as typed: separated by commas, semicolons or spaces. */
const recipients = (text: string) => text.split(/[\s,;]+/).filter(Boolean);

const received = (mail: Mail) =>
  new Date(mail.received).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The desktop's Email app: Configure Mail sets the account, Compose sends a mail by SMTP, and
 * Receive fetches the account's mail by POP3 into the inbox.
 */
export function EmailApp({
  device,
  backend,
}: {
  device: HostDevice;
  backend: Pick<HostBackend, 'mail'>;
}) {
  const account = device.config.mail;
  const [view, setView] = useState<View>(account ? 'inbox' : 'configure');
  const [status, setStatus] = useState<Status>();
  const [busy, setBusy] = useState(false);

  /** Runs a send or a receive, showing `pending` until it ends and then what it says. */
  const run = async (pending: string, work: () => Promise<Status>) => {
    setBusy(true);
    setStatus({ text: pending });
    const done = await work().catch((error: unknown) => ({ text: message(error), error: true }));
    setStatus(done);
    setBusy(false);
    return !done.error;
  };

  const send = async (to: readonly string[], subject: string, body: string) => {
    if (!account) return false;
    return run(
      `Sending mail to ${to.join(', ')}, with subject : ${subject} ..  Mail Server: ${account.outgoing}`,
      async () => {
        const outcome = await backend.mail(device.id, {
          kind: 'send',
          server: account.outgoing,
          mail: { from: account.address, to, subject, body },
        });
        return outcome.kind === 'failed'
          ? { text: `Send Mail Failed: ${failureReason(outcome.failure)}`, error: true }
          : { text: 'Send Success.' };
      },
    );
  };

  const receive = () => {
    if (!account) return;
    void run(`Receiving mail from POP3 Server ${account.incoming}`, async () => {
      const outcome = await backend.mail(device.id, {
        kind: 'receive',
        server: account.incoming,
        username: account.username,
        password: account.password,
      });
      if (outcome.kind === 'failed') {
        return { text: `Receive Mail Failed: ${failureReason(outcome.failure)}`, error: true };
      }
      if (outcome.kind === 'received') deliver(device.id, outcome.mails);
      return { text: 'Receive Mail Success.' };
    });
  };

  return (
    <div data-testid="email-app" className="flex min-h-0 flex-1 flex-col">
      <div
        role="toolbar"
        aria-label="Mail"
        className="flex shrink-0 items-center gap-1 border-b border-line px-2 py-1.5"
      >
        <ToolButton
          testId="email-inbox-tab"
          pressed={view === 'inbox'}
          disabled={!account}
          onClick={() => setView('inbox')}
        >
          <InboxIcon />
          Inbox
        </ToolButton>
        <ToolButton
          testId="email-compose-tab"
          pressed={view === 'compose'}
          disabled={!account}
          onClick={() => setView('compose')}
        >
          <MailPlusIcon />
          Compose
        </ToolButton>
        <ToolButton
          testId="email-receive"
          disabled={!account || busy}
          onClick={() => {
            setView('inbox');
            receive();
          }}
        >
          <RefreshCwIcon />
          Receive
        </ToolButton>
        <span className="flex-1" />
        <ToolButton
          testId="email-configure-tab"
          pressed={view === 'configure'}
          onClick={() => setView('configure')}
        >
          <SettingsIcon />
          Configure Mail
        </ToolButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {view === 'configure' ? (
          <Configure
            device={device}
            onSaved={() => {
              setStatus({ text: 'Mail settings saved.' });
              setView('inbox');
            }}
          />
        ) : view === 'compose' ? (
          <Compose
            busy={busy}
            onSend={async (to, subject, body) => {
              const sent = await send(to, subject, body);
              if (sent) setView('inbox');
              return sent;
            }}
          />
        ) : (
          <Inbox device={device} />
        )}
      </div>
      <p
        role="status"
        aria-label="Mail status"
        data-testid="email-status"
        className={cn(
          'flex min-h-6 shrink-0 items-center border-t border-line bg-surface-2/40 px-2.5 py-1 font-mono text-2xs',
          status?.error ? 'text-err' : 'text-fg-3',
        )}
      >
        {status?.text}
      </p>
    </div>
  );
}

function ToolButton({
  testId,
  pressed,
  disabled,
  onClick,
  children,
}: {
  testId: string;
  pressed?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      data-testid={testId}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

function TextField({
  label,
  value,
  onChange,
  type = 'text',
  testId,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: 'text' | 'password';
  testId: string;
  placeholder?: string;
}) {
  const id = useId();
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-2xs text-fg-3">
        {label}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        placeholder={placeholder}
        data-testid={testId}
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => onChange(event.target.value)}
        className="h-7 w-full min-w-0 rounded-md border border-line bg-surface-1 px-2 font-mono text-[0.6875rem] text-fg-1 transition-colors outline-none placeholder:text-fg-3/70 hover:border-line-strong focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/25"
      />
    </div>
  );
}

/** Configure Mail: the account the app sends and receives as, kept in the host's config. */
function Configure({ device, onSaved }: { device: HostDevice; onSaved: () => void }) {
  const [form, setForm] = useState<MailAccount>(() => device.config.mail ?? BLANK_ACCOUNT);
  const field = (key: keyof MailAccount, label: string, placeholder: string) => (
    <TextField
      label={label}
      value={form[key]}
      placeholder={placeholder}
      type={key === 'password' ? 'password' : 'text'}
      testId={`email-config-${key}`}
      onChange={(value) => setForm((current) => ({ ...current, [key]: value }))}
    />
  );
  const save = (event: FormEvent) => {
    event.preventDefault();
    const mail = Object.fromEntries(
      Object.entries(form).map(([key, value]) => [key, key === 'password' ? value : value.trim()]),
    ) as MailAccount;
    const saved = editorStore.getState().updateConfig({
      device: device.id,
      kind: device.kind,
      config: { ...device.config, mail },
    });
    if (saved.ok) onSaved();
  };
  return (
    <form
      aria-label="Configure Mail"
      data-testid="email-configure"
      onSubmit={save}
      className="flex flex-col gap-2.5 px-3 py-3"
    >
      <h4 className="text-2xs font-medium text-fg-3">User information</h4>
      {field('name', 'Your Name', 'User 1')}
      {field('address', 'Email Address', 'user1@lab.local')}
      <h4 className="border-t border-line pt-2.5 text-2xs font-medium text-fg-3">
        Server information
      </h4>
      {field('incoming', 'Incoming Mail Server', '192.168.1.20')}
      {field('outgoing', 'Outgoing Mail Server', '192.168.1.20')}
      <h4 className="border-t border-line pt-2.5 text-2xs font-medium text-fg-3">
        Logon information
      </h4>
      {field('username', 'User Name', 'user1')}
      {field('password', 'Password', '')}
      <div className="flex justify-end pt-1">
        <Button type="submit" size="sm" variant="primary" data-testid="email-config-save">
          Save
        </Button>
      </div>
    </form>
  );
}

/** Compose: a new mail. The form keeps what was typed until the mail goes. */
function Compose({
  busy,
  onSend,
}: {
  busy: boolean;
  onSend: (to: readonly string[], subject: string, body: string) => Promise<boolean>;
}) {
  const [to, setTo] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const bodyId = useId();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void onSend(recipients(to), subject, body);
  };
  return (
    <form
      aria-label="Compose Mail"
      data-testid="email-compose"
      onSubmit={submit}
      className="flex flex-col gap-2.5 px-3 py-3"
    >
      <TextField
        label="To"
        value={to}
        onChange={setTo}
        testId="email-to"
        placeholder="user2@lab.local"
      />
      <TextField label="Subject" value={subject} onChange={setSubject} testId="email-subject" />
      <div className="flex flex-col gap-1">
        <label htmlFor={bodyId} className="text-2xs text-fg-3">
          Message
        </label>
        <textarea
          id={bodyId}
          value={body}
          data-testid="email-body"
          onChange={(event) => setBody(event.target.value)}
          className="min-h-32 resize-y rounded-md border border-line bg-surface-1 p-2 font-mono text-[0.6875rem] text-fg-1 outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/25"
        />
      </div>
      <div className="flex justify-end">
        <Button
          type="submit"
          size="sm"
          variant="primary"
          data-testid="email-send"
          disabled={busy || recipients(to).length === 0}
        >
          <SendIcon />
          Send
        </Button>
      </div>
    </form>
  );
}

/** The mail received so far, newest first, with the chosen one open underneath. */
function Inbox({ device }: { device: HostDevice }) {
  const mails = useInbox(device.id);
  const [open, setOpen] = useState<Mail>();
  const newest = [...mails].reverse();
  if (mails.length === 0) {
    return (
      <p data-testid="email-inbox-empty" className="px-3 py-6 text-center text-xs text-fg-3">
        No mail yet. Receive fetches new mail from the incoming server.
      </p>
    );
  }
  return (
    <div className="flex flex-col">
      <div
        aria-hidden="true"
        className="grid grid-cols-[1fr_1.4fr_auto] gap-2 border-b border-line px-3 py-1 text-2xs font-medium text-fg-3"
      >
        <span>From</span>
        <span>Subject</span>
        <span>Received</span>
      </div>
      <ul aria-label="Inbox" data-testid="email-inbox" className="flex flex-col">
        {newest.map((mail, at) => (
          <li key={`${mail.received}-${at}`}>
            <button
              type="button"
              data-testid="email-inbox-row"
              aria-pressed={open === mail}
              onClick={() => setOpen(mail)}
              className="grid w-full cursor-default grid-cols-[1fr_1.4fr_auto] gap-2 border-b border-line px-3 py-1.5 text-left text-xs text-fg-1 hover:bg-surface-2 aria-pressed:bg-surface-3"
            >
              <span className="truncate">{mail.from}</span>
              <span className="truncate">{mail.subject || '(no subject)'}</span>
              <span className="text-2xs text-fg-3 tabular-nums">{received(mail)}</span>
            </button>
          </li>
        ))}
      </ul>
      {open && (
        <section
          aria-label="Message"
          data-testid="email-reader"
          className="flex flex-col gap-1 px-3 py-3 text-xs"
        >
          <p className="text-fg-3">
            From <span className="text-fg-1">{open.from}</span>
          </p>
          <p className="text-fg-3">
            To <span className="text-fg-1">{open.to}</span>
          </p>
          <p className="font-medium text-fg-1">{open.subject || '(no subject)'}</p>
          <pre className="mt-1 font-mono text-[0.6875rem] whitespace-pre-wrap text-fg-1">
            {open.body}
          </pre>
        </section>
      )}
    </div>
  );
}
