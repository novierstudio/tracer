import { HoverCard } from 'radix-ui';
import { useState, type ReactNode } from 'react';
import { describeModel, portRows, shortPortName, type PortRow } from '@/features/inspector/view';
import type { DeviceId } from '@/model';
import { useEditor } from '@/model/react';
import { cn } from '@/ui/cn';

const MAX_ROWS = 8;

// Ports in use or with an address say the most, so they come first; free ones fill the rest.
const rank = (row: PortRow) => (row.peer ? 0 : 'ipv4' in row && row.ipv4 ? 1 : 2);

function PortLine({ row }: { row: PortRow }) {
  const address = 'ipv4' in row && row.ipv4 && `${row.ipv4.address}/${row.ipv4.prefixLength}`;
  return (
    <li className="grid grid-cols-[auto_3.5rem_1fr] items-center gap-x-2 py-0.5">
      <span
        aria-hidden
        data-state={row.state}
        className={cn(
          'size-1.5 rounded-full',
          row.state === 'up' && 'bg-ok',
          row.state === 'down' && 'bg-err',
          row.state === 'free' && 'border border-line-strong',
        )}
      />
      <span className="font-mono text-fg-1">{shortPortName(row.id)}</span>
      <span className="truncate text-fg-3">
        {row.peer
          ? `${row.peer.device.config.hostname} ${shortPortName(row.peer.port)}`
          : address || 'free'}
        {row.peer && address && <span className="ml-1.5 font-mono text-fg-2">{address}</span>}
      </span>
    </li>
  );
}

function DeviceSummary({ device: id }: { device: DeviceId }) {
  const topology = useEditor((state) => state.topology);
  const device = topology.devices[id];
  if (!device) return null;
  const rows = portRows(topology, device).sort((a, b) => rank(a) - rank(b));
  const shown = rows.slice(0, MAX_ROWS);
  const hidden = rows.length - shown.length;
  return (
    <>
      <p className="flex items-baseline justify-between gap-3">
        <span className="font-semibold text-fg-1">{device.config.hostname}</span>
        <span className="text-fg-3">{describeModel(device).name}</span>
      </p>
      <ul aria-label="Interfaces" className="mt-1.5 border-t border-line pt-1.5">
        {shown.map((row) => (
          <PortLine key={row.id} row={row} />
        ))}
      </ul>
      {hidden > 0 && (
        <p className="mt-1 text-fg-3">
          + {hidden} more free {hidden === 1 ? 'port' : 'ports'}
        </p>
      )}
    </>
  );
}

type Props = { device: DeviceId; disabled: boolean; children: ReactNode };

/** Hovering a device for a moment lists its interfaces, links and addresses. */
export function DeviceHoverCard({ device, disabled, children }: Props) {
  const [open, setOpen] = useState(false);
  return (
    <HoverCard.Root open={open && !disabled} onOpenChange={setOpen} openDelay={500} closeDelay={80}>
      <HoverCard.Trigger asChild>{children}</HoverCard.Trigger>
      <HoverCard.Portal>
        <HoverCard.Content
          side="right"
          align="start"
          sideOffset={14}
          collisionPadding={12}
          className="pointer-events-none z-40 w-64 animate-fade-in rounded-lg border border-line bg-surface-1 px-3 py-2 text-xs shadow-pop"
        >
          <DeviceSummary device={device} />
        </HoverCard.Content>
      </HoverCard.Portal>
    </HoverCard.Root>
  );
}
