import { XIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/ui/button';
import { cn } from '@/ui/cn';
import { SettingRow, Toggle } from '../config/controls';

/** A service's on/off switch, as Packet Tracer's On and Off buttons. */
export function ServiceSwitch({
  label,
  rowLabel = 'Service',
  checked,
  onChange,
}: {
  label: string;
  rowLabel?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <SettingRow label={rowLabel}>
      <span className="flex h-7 items-center gap-2 text-xs text-fg-2">
        <Toggle label={label} checked={checked} onChange={onChange} />
        <span aria-hidden="true">{checked ? 'On' : 'Off'}</span>
      </span>
    </SettingRow>
  );
}

export const onOff = (on: boolean) => (on ? 'On' : 'Off');

export const firstIssue = (error: { issues: readonly { message: string }[] }) =>
  error.issues[0]?.message ?? 'Invalid value';

/**
 * Why `username` cannot be a new account, or undefined when it can. Accounts are matched without
 * regard to case, as the mail server matches mailboxes.
 */
export function usernameProblem(username: string, taken: readonly string[]): string | undefined {
  if (!username) return 'Type a username';
  if (/\s/.test(username)) return 'A username must have no spaces';
  if (taken.some((other) => other.toLowerCase() === username.toLowerCase())) {
    return `${username} already has an account`;
  }
  return undefined;
}

/** A small table of rows, with a header and a line for when it is empty. */
export function ServiceTable({
  label,
  testId,
  columns,
  empty,
  children,
  scroll = false,
  wide = false,
}: {
  label: string;
  testId?: string;
  /** Each column's heading and width class; an empty heading is a remove-button column. */
  columns: readonly (readonly [heading: string, width?: string])[];
  empty: string | undefined;
  children: ReactNode;
  scroll?: boolean;
  /** Columns as wide as their text, scrolling sideways in a narrow panel, as a log needs. */
  wide?: boolean;
}) {
  const table = (
    <table
      aria-label={label}
      data-testid={testId}
      className={cn('text-xs', wide ? 'w-max min-w-full' : 'w-full table-fixed')}
    >
      <thead>
        <tr className="text-left text-2xs text-fg-3">
          {columns.map(([heading, width], index) => (
            <th key={index} scope="col" className={cn('pb-1 font-normal', width)}>
              {heading || <span className="sr-only">Remove</span>}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {empty !== undefined && (
          <tr>
            <td colSpan={columns.length} className="py-1 text-fg-3">
              {empty}
            </td>
          </tr>
        )}
        {children}
      </tbody>
    </table>
  );
  return scroll ? <div className="max-h-48 overflow-auto">{table}</div> : table;
}

export const cellClass = 'truncate py-1 pr-2 font-mono text-[0.6875rem] text-fg-1';

export function RemoveButton({ name, onClick }: { name: string; onClick: () => void }) {
  return (
    <Button
      size="icon-sm"
      variant="ghost"
      aria-label={`Remove ${name}`}
      className="size-6"
      onClick={onClick}
    >
      <XIcon />
    </Button>
  );
}

export function FormError({ id, message }: { id: string; message: string | undefined }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="text-2xs text-err">
      {message}
    </p>
  );
}
