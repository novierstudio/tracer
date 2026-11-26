import { PlusIcon } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import type { FtpPermissions, FtpUser } from '@/model';
import { Button } from '@/ui/button';
import { cn } from '@/ui/cn';
import { inputClass } from '../config/controls';
import { cellClass, FormError, RemoveButton, ServiceTable, usernameProblem } from './parts';

/** Packet Tracer's permission boxes, in its order. */
const PERMISSIONS: readonly (readonly [key: keyof FtpPermissions, label: string])[] = [
  ['write', 'Write'],
  ['read', 'Read'],
  ['delete', 'Delete'],
  ['rename', 'Rename'],
  ['list', 'List'],
];

/** The letters its user table shows for each permission, in its order: `RWDNL` for all five. */
const LETTERS: readonly (readonly [key: keyof FtpPermissions, letter: string])[] = [
  ['read', 'R'],
  ['write', 'W'],
  ['delete', 'D'],
  ['rename', 'N'],
  ['list', 'L'],
];

const permissionLetters = (permissions: FtpPermissions) =>
  LETTERS.filter(([key]) => permissions[key])
    .map(([, letter]) => letter)
    .join('');

const NO_PERMISSIONS: FtpPermissions = {
  write: false,
  read: false,
  delete: false,
  rename: false,
  list: false,
};

/**
 * The FTP accounts, and Packet Tracer's User Setup: Add makes a new account, picking one in the
 * table loads it so Save can change it, and each row can be removed.
 */
export function FtpUsers({
  users,
  onChange,
}: {
  users: readonly FtpUser[];
  onChange: (users: FtpUser[]) => void;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [permissions, setPermissions] = useState(NO_PERMISSIONS);
  const [picked, setPicked] = useState<string>();
  const [error, setError] = useState<string>();
  const id = useId();

  const clear = () => {
    setUsername('');
    setPassword('');
    setPermissions(NO_PERMISSIONS);
    setPicked(undefined);
    setError(undefined);
  };

  const account = (others: readonly FtpUser[]): FtpUser | undefined => {
    const name = username.trim();
    const problem =
      usernameProblem(
        name,
        others.map((user) => user.username),
      ) ?? (password ? undefined : 'Type a password');
    if (problem) {
      setError(problem);
      return undefined;
    }
    return { username: name, password, permissions };
  };

  const add = (event: FormEvent) => {
    event.preventDefault();
    const user = account(users);
    if (!user) return;
    onChange([...users, user]);
    clear();
  };

  const save = () => {
    const user = account(users.filter((other) => other.username !== picked));
    if (!user) return;
    onChange(users.map((other) => (other.username === picked ? user : other)));
    clear();
  };

  const pick = (user: FtpUser) => {
    setUsername(user.username);
    setPassword(user.password);
    setPermissions(user.permissions);
    setPicked(user.username);
    setError(undefined);
  };

  return (
    <div className="flex flex-col gap-1.5">
      <ServiceTable
        label="FTP users"
        columns={[['Username'], ['Password'], ['Permission', 'w-[4.5rem]'], ['', 'w-7']]}
        empty={users.length === 0 ? 'No users yet.' : undefined}
      >
        {users.map((user) => (
          <tr
            key={user.username}
            className={cn('border-t border-line', picked === user.username && 'bg-surface-2')}
          >
            <td className={cellClass}>
              <button
                type="button"
                aria-pressed={picked === user.username}
                aria-label={`Edit ${user.username}`}
                onClick={() => pick(user)}
                className="w-full cursor-default truncate text-left outline-none focus-visible:underline"
              >
                {user.username}
              </button>
            </td>
            <td className={cellClass}>{user.password}</td>
            <td className={cellClass}>{permissionLetters(user.permissions)}</td>
            <td className="py-0.5 text-right">
              <RemoveButton
                name={user.username}
                onClick={() => {
                  onChange(users.filter((other) => other !== user));
                  if (picked === user.username) clear();
                }}
              />
            </td>
          </tr>
        ))}
      </ServiceTable>
      <form aria-label="FTP user setup" onSubmit={add} className="flex flex-col gap-1.5">
        <div className="grid grid-cols-2 gap-1.5">
          <input
            aria-label="FTP username"
            value={username}
            placeholder="Username"
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
            aria-label="FTP password"
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
        </div>
        <fieldset className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-fg-2">
          <legend className="sr-only">Permissions</legend>
          {PERMISSIONS.map(([key, label]) => (
            <label key={key} className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={permissions[key]}
                onChange={(event) =>
                  setPermissions({ ...permissions, [key]: event.target.checked })
                }
                className="size-3.5 accent-accent"
              />
              {label}
            </label>
          ))}
        </fieldset>
        <div className="flex justify-end gap-1.5">
          <Button
            size="sm"
            variant="ghost"
            aria-label="Save FTP user"
            disabled={picked === undefined}
            onClick={save}
          >
            Save
          </Button>
          <Button type="submit" size="sm" aria-label="Add FTP user" className="px-1.5">
            <PlusIcon />
            Add
          </Button>
        </div>
        <FormError id={`${id}-error`} message={error} />
      </form>
    </div>
  );
}
