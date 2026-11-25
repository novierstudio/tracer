import { CableIcon, Trash2Icon } from 'lucide-react';
import type { Device, Link, Topology } from '@/model';
import { Button } from '@/ui/button';
import { deleteItems, selectDevice } from './actions';
import { DeviceTile, Mono, Section } from './parts';
import { CABLE_LABELS, describeModel, selectionSummary, shortPortName } from './view';

/** Several things selected: what they are, and the actions that apply to all of them. */
export function SelectionInspector({
  devices,
  links,
  topology,
}: {
  devices: Device[];
  links: Link[];
  topology: Topology;
}) {
  const count = devices.length + links.length;
  const hostname = (id: Device['id']) => topology.devices[id]?.config.hostname ?? '?';
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <header className="flex flex-col gap-0.5 px-3 pt-1 pb-3">
        <h3 className="text-base font-semibold text-fg-1">{count} items selected</h3>
        <p className="text-xs text-fg-2">{selectionSummary(devices, links)}</p>
      </header>
      <div className="border-t border-line px-3 py-3">
        <Button
          size="sm"
          onClick={() =>
            deleteItems(
              devices.map((d) => d.id),
              links.map((l) => l.id),
            )
          }
        >
          <Trash2Icon />
          Delete {count} items
        </Button>
      </div>
      {devices.length > 0 && (
        <Section title="Devices" className="border-t border-line">
          <ul className="-mx-1.5 flex flex-col">
            {devices.map((device) => (
              <li key={device.id}>
                <button
                  type="button"
                  onClick={() => selectDevice(device.id)}
                  className="flex w-full cursor-default items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-surface-2"
                >
                  <DeviceTile device={device} className="size-6" />
                  <span className="truncate text-xs font-medium text-fg-1">
                    {device.config.hostname}
                  </span>
                  <span className="ml-auto truncate text-2xs text-fg-3">
                    {describeModel(device).name}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Section>
      )}
      {links.length > 0 && (
        <Section title="Links" className="border-t border-line">
          <ul className="flex flex-col gap-1.5">
            {links.map((link) => (
              <li key={link.id} className="flex items-center gap-2 text-xs text-fg-1">
                <CableIcon
                  className="size-3.5 shrink-0 text-fg-3"
                  aria-label={CABLE_LABELS[link.cable]}
                />
                <span className="flex min-w-0 items-baseline gap-1 truncate">
                  {hostname(link.a.device)}{' '}
                  <Mono className="text-fg-2">{shortPortName(link.a.port)}</Mono>
                  <span className="text-fg-3">–</span>
                  {hostname(link.b.device)}{' '}
                  <Mono className="text-fg-2">{shortPortName(link.b.port)}</Mono>
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}
