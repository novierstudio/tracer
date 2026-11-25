import { Command as Cmdk } from 'cmdk';
import { SearchIcon } from 'lucide-react';
import { Popover } from 'radix-ui';
import { useMemo, type RefObject } from 'react';
import { useEditor } from '@/model/react';
import type { DeviceId, Topology } from '@/model';
import { cn } from '@/ui/cn';
import {
  CABLE_LABELS,
  portOptions,
  requiredMedium,
  type CableChoice,
  type PortOption,
} from './cables';
import { cableTool, useCableTool, type CableStep } from './cableTool';

type Picking = Extract<CableStep, { at: 'source-port' | 'target-port' }>;

function statusText(option: PortOption): string {
  switch (option.status) {
    case 'free':
      return option.id;
    case 'used':
      return `In use, to ${option.peer}`;
    case 'incompatible':
      return `Needs a ${option.kind === 'serial' ? 'serial' : 'copper'} cable`;
  }
}

// Ports match when every typed word appears in the short or full name: "0/3", "gi 1", "serial".
function filterPorts(_value: string, search: string, keywords: string[] = []): number {
  const haystack = keywords.join(' ').toLowerCase();
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  return words.every((word) => haystack.includes(word)) ? 1 : 0;
}

function PickerBody({
  topology,
  picking,
  cable,
}: {
  topology: Topology;
  picking: Picking;
  cable: CableChoice;
}) {
  const device = topology.devices[picking.device];
  const source = picking.at === 'target-port' ? picking.source : undefined;
  const options = portOptions(topology, picking.device, requiredMedium(topology, cable, source));
  const free = options.filter((option) => option.status === 'free').length;
  const hostname = device?.config.hostname ?? '';
  const step = source ? 'Plug the other end into' : 'Plug the first end into';

  return (
    <Cmdk label={`Ports on ${hostname}`} loop filter={filterPorts}>
      <div className="flex items-baseline justify-between gap-3 px-3 pt-2.5 pb-1.5">
        <div className="min-w-0">
          <p className="text-2xs text-fg-3">{step}</p>
          <p className="truncate text-sm font-semibold text-fg-1">{hostname}</p>
        </div>
        <span className="shrink-0 rounded-sm bg-surface-2 px-1.5 text-2xs leading-5 font-medium text-fg-2">
          {CABLE_LABELS[cable]}
        </span>
      </div>
      <div className="mx-2 flex items-center gap-2 rounded-md border border-line bg-surface-0 px-2 focus-within:border-accent/60">
        <SearchIcon className="size-3.5 shrink-0 text-fg-3" aria-hidden />
        <Cmdk.Input
          placeholder={`Filter ${options.length} ports`}
          className="h-7 min-w-0 flex-1 bg-transparent text-xs text-fg-1 outline-none placeholder:text-fg-3 focus-visible:outline-none"
        />
      </div>
      <Cmdk.List className="max-h-64 scroll-py-1 overflow-y-auto p-1 pt-1.5">
        <Cmdk.Empty className="px-2 py-4 text-center text-xs text-fg-3">
          No matching ports
        </Cmdk.Empty>
        {free === 0 && (
          <p className="px-2 pt-1 pb-2 text-xs text-fg-2">
            No free {source ? 'matching ' : ''}ports on {hostname}.
          </p>
        )}
        {options.map((option) => (
          <Cmdk.Item
            key={option.id}
            value={option.id}
            keywords={[option.short, option.id]}
            disabled={option.status !== 'free'}
            onSelect={() => cableTool.getState().choosePort(option.id)}
            className={cn(
              'group flex h-8 cursor-default items-center gap-2 rounded-md px-2 text-xs select-none',
              'data-[selected=true]:bg-surface-2 dark:data-[selected=true]:bg-surface-3',
              'data-[disabled=true]:text-fg-3',
            )}
          >
            <span
              aria-hidden
              className={cn(
                'size-1.5 shrink-0 rounded-full',
                option.status === 'free' ? 'bg-ok' : 'border border-fg-3/60',
              )}
            />
            <span className="w-14 shrink-0 font-mono font-medium text-fg-1 group-data-[disabled=true]:text-fg-3">
              {option.short}
            </span>
            <span className="min-w-0 truncate text-fg-3">{statusText(option)}</span>
          </Cmdk.Item>
        ))}
      </Cmdk.List>
    </Cmdk>
  );
}

function tileRect(device: DeviceId | undefined): DOMRect {
  const tile = document.querySelector(`.react-flow__node[data-id="${device}"] .device-tile`);
  return tile?.getBoundingClientRect() ?? new DOMRect();
}

/** The port menu that opens beside a device while the cable tool waits for a port. */
export function PortPicker({ canvas }: { canvas: RefObject<HTMLElement | null> }) {
  const step = useCableTool((state) => state.step);
  const cable = useCableTool((state) => state.cable);
  const picking = step?.at === 'source-port' || step?.at === 'target-port' ? step : null;
  const topology = useEditor((state) => (picking ? state.topology : null));
  const device: DeviceId | undefined = picking?.device;
  const open = !!picking && !!topology && !!device && device in topology.devices;

  // Follows the device's tile on screen, so the menu tracks pans and zooms while it is open.
  const anchor = useMemo(
    () => ({ current: { getBoundingClientRect: () => tileRect(device) } }),
    [device],
  );

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) cableTool.getState().dismissPicker();
      }}
    >
      <Popover.Anchor virtualRef={anchor} />
      <Popover.Portal>
        <Popover.Content
          side="right"
          align="start"
          sideOffset={12}
          alignOffset={-8}
          collisionPadding={12}
          updatePositionStrategy="always"
          onEscapeKeyDown={(event) => {
            event.preventDefault();
            cableTool.getState().escape();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            canvas.current?.focus({ preventScroll: true });
          }}
          className="z-40 w-64 animate-fade-in overflow-hidden rounded-lg bg-surface-1 text-fg-1 shadow-pop outline-none"
        >
          {open && picking && topology && (
            <PickerBody topology={topology} picking={picking} cable={cable} />
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
