import type { SyslogEntry } from '@/engine/api';
import { ServiceTable } from './parts';

const cell = 'py-1 pr-3 font-mono text-[0.6875rem] whitespace-pre text-fg-1';

/** What the syslog service has logged, oldest first, as Packet Tracer's Time, HostName, Message. */
export function SyslogTable({ entries }: { entries: readonly SyslogEntry[] }) {
  return (
    <ServiceTable
      label="Syslog messages"
      testId="syslog-messages"
      columns={[['Time'], ['HostName'], ['Message']]}
      empty={entries.length === 0 ? 'No messages yet.' : undefined}
      scroll
      wide
    >
      {entries.map((entry, index) => (
        <tr key={index} className="border-t border-line">
          <td className={cell}>{entry.time}</td>
          <td className={cell}>{entry.host}</td>
          <td className={cell}>{entry.message}</td>
        </tr>
      ))}
    </ServiceTable>
  );
}
