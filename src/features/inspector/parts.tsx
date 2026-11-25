import type { ReactNode } from 'react';
import { DeviceIcon } from '@/devices/icons';
import type { Device, PortId } from '@/model';
import { cn } from '@/ui/cn';
import { selectDevice } from './actions';
import { describeModel, shortPortName, type PortState } from './view';

export function Section({
  title,
  aside,
  children,
  className,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section aria-label={title} className={cn('flex flex-col gap-2 px-3 py-3', className)}>
      <div className="flex h-5 items-center justify-between gap-2">
        <h3 className="text-2xs font-medium tracking-wide text-fg-3 uppercase">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** Label/value rows. Labels take the muted token so values carry the weight. */
export function Facts({ rows }: { rows: [label: string, value: ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[minmax(5.5rem,auto)_1fr] gap-x-3 gap-y-1.5 text-xs">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-fg-3">{label}</dt>
          <dd className="min-w-0 truncate text-fg-1">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn('font-mono text-[0.6875rem] tabular-nums', className)}>{children}</span>
  );
}

export const STATE_LABELS: Record<PortState, string> = { up: 'Up', down: 'Down', free: 'Free' };

/** Colour is never the only signal: up is a filled dot, down a ring, free a dash. */
export function StateDot({ state, className }: { state: PortState; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-block shrink-0',
        state === 'up' && 'size-2 rounded-full bg-ok',
        state === 'down' && 'size-2 rounded-full border-[1.5px] border-err',
        state === 'free' && 'h-[1.5px] w-2 rounded-full bg-fg-3/60',
        className,
      )}
    />
  );
}

export function DeviceTile({ device, className }: { device: Device; className?: string }) {
  return (
    <DeviceIcon
      name={describeModel(device).icon}
      className={cn('shrink-0 text-fg-1', !device.powered && 'opacity-50', className)}
    />
  );
}

/** "SW1 Gi0/1", where the hostname selects that device. */
export function PeerButton({ device, port }: { device: Device; port: PortId }) {
  return (
    <button
      type="button"
      onClick={() => selectDevice(device.id)}
      className="inline-flex max-w-full min-w-0 cursor-default items-baseline gap-1.5 rounded-sm text-left text-xs text-fg-1 hover:text-accent-text"
      aria-label={`Select ${device.config.hostname} (${port})`}
    >
      <span className="truncate font-medium">{device.config.hostname}</span>
      <Mono className="text-fg-2">{shortPortName(port)}</Mono>
    </button>
  );
}
