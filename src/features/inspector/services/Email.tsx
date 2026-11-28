import { PlusIcon } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { DomainName, type MailUser } from '@/model';
import { Button } from '@/ui/button';
import { inputClass, SettingRow } from '../config/controls';
import {
  cellClass,
  firstIssue,
  FormError,
  RemoveButton,
  ServiceTable,
  usernameProblem,
} from './parts';

/** The mail domain, as Packet Tracer's Domain Name field and its Set button. */
export function MailDomain({ domain, onSet }: { domain: string; onSet: (domain: string) => void }) {
  // null while not editing, so undo shows through.
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const id = useId();
  const set = (event: FormEvent) => {
    event.preventDefault();
    if (draft === null) return;
    if (!draft.trim()) return setError('Type a domain name, such as lab.local');
    const parsed = DomainName.safeParse(draft);
    if (!parsed.success) return setError(firstIssue(parsed.error));
    if (parsed.data !== domain) onSet(parsed.data);
    setDraft(null);
    setError(undefined);
  };
  return (
    <form aria-label="Mail domain" onSubmit={set}>
      <SettingRow label="Domain Name" htmlFor={id} error={error} errorId={`${id}-error`}>
        <div className="flex min-w-0 gap-1.5">
          <input
            id={id}
            value={draft ?? domain}
            placeholder="lab.local"
            spellCheck={false}
            autoComplete="off"
            aria-invalid={error !== undefined}
            aria-describedby={error ? `${id}-error` : undefined}
            onChange={(event) => {
              setDraft(event.target.value);
              setError(undefined);
            }}
            className={inputClass(true, error !== undefined)}
          />
          <Button type="submit" size="sm" aria-label="Set domain name">
            Set
          </Button>
        </div>
      </SettingRow>
    </form>
  );
}

/** The mail accounts, how many mails wait for each, and a row to add one. */
export function MailUsers({
  users,
  mailboxes,
  onChange,
}: {
  users: readonly MailUser[];
  /** Mails waiting, by user name in lower case; undefined while the simulation has not said. */
  mailboxes: Readonly<Record<string, number>> | undefined;
  onChange: (users: MailUser[]) => void;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string>();
  const id = useId();

  const add = (event: FormEvent) => {
    event.preventDefault();
    const name = username.trim();
    const problem =
      usernameProblem(
        name,
        users.map((user) => user.username),
      ) ?? (password ? undefined : 'Type a password');
    if (problem) return setError(problem);
    onChange([...users, { username: name, password }]);
    setUsername('');
    setPassword('');
    setError(undefined);
  };

  return (
    <div className="flex flex-col gap-1.5">
      <ServiceTable
        label="Mail users"
        columns={[['User'], ['Password'], ['Mails', 'w-12'], ['', 'w-7']]}
        empty={users.length === 0 ? 'No users yet.' : undefined}
      >
        {users.map((user) => (
          <tr key={user.username} className="border-t border-line">
            <td className={cellClass}>{user.username}</td>
            <td className={cellClass}>{user.password}</td>
            <td className={cellClass}>{mailboxes?.[user.username.toLowerCase()] ?? 0}</td>
            <td className="py-0.5 text-right">
              <RemoveButton
                name={user.username}
                onClick={() => onChange(users.filter((other) => other !== user))}
              />
            </td>
          </tr>
        ))}
      </ServiceTable>
      <form aria-label="Add mail user" onSubmit={add} className="flex flex-col gap-1">
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-1.5">
          <input
            aria-label="Mail user"
            value={username}
            placeholder="User"
            spellCheck={false}
            autoComplete="off"
            aria-invalid={error !== undefined}
            aria-describedby={error ? `${id}-error` : undefined}
            onChange={(event) => {
              setUsername(event.target.value);
              setError(undefined);
            }}
            className={inputClass(true, error !== undefined)}
          />
          <input
            aria-label="Mail password"
            value={password}
            placeholder="Password"
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => {
              setPassword(event.target.value);
              setError(undefined);
            }}
            className={inputClass(true, false)}
          />
          <Button type="submit" size="sm" aria-label="Add mail user" className="px-1.5">
            <PlusIcon />
            Add
          </Button>
        </div>
        <FormError id={`${id}-error`} message={error} />
      </form>
    </div>
  );
}
