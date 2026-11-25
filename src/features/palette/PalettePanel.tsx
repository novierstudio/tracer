import { CableIcon, RouterIcon, SearchIcon, StickyNoteIcon, type LucideIcon } from 'lucide-react';
import { useId, useState, type ComponentProps, type DragEvent } from 'react';
import {
  CATEGORY_LABELS,
  DEVICE_CATEGORIES,
  DEVICE_MODELS,
  portSummary,
  type DeviceCategory,
  type DeviceModel,
} from '@/devices/catalog';
import { DeviceIcon } from '@/devices/icons';
import { EmptyState } from '@/ui/empty-state';
import { Input } from '@/ui/input';

export const PALETTE_SECTIONS = ['devices', 'connections', 'annotate'] as const;
export type PaletteSection = (typeof PALETTE_SECTIONS)[number];

/** The drop payload is the catalog model id. */
export const DEVICE_DRAG_TYPE = 'application/x-tracer-device';

export const SECTION_INFO: Record<
  PaletteSection,
  { label: string; icon: LucideIcon; search: string; empty: string; hint: string }
> = {
  devices: {
    label: 'Devices',
    icon: RouterIcon,
    search: 'Search devices',
    empty: 'No matching devices',
    hint: 'Try a device name, a category or a port type such as “serial”.',
  },
  connections: {
    label: 'Connections',
    icon: CableIcon,
    search: 'Search cables',
    empty: 'No cables yet',
    hint: 'Copper, crossover, fiber, serial and console cables will be listed here. Pick one, then click two ports to connect them.',
  },
  annotate: {
    label: 'Annotate',
    icon: StickyNoteIcon,
    search: 'Search annotations',
    empty: 'Nothing to annotate yet',
    hint: 'Notes, text, areas and shapes for labelling your lab will be listed here.',
  },
};

type Entry = { model: DeviceModel; summary: string; haystack: string };

const ENTRIES: Entry[] = DEVICE_MODELS.map((model) => {
  const summary = portSummary(model);
  const words = [model.name, CATEGORY_LABELS[model.category], model.hostnamePrefix, summary];
  return { model, summary, haystack: words.join(' ').toLowerCase() };
});

/** Catalog groups in category order, keeping only entries that match every word of the query. */
export function filterCatalog(query: string): { category: DeviceCategory; entries: Entry[] }[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = ENTRIES.filter((entry) => words.every((word) => entry.haystack.includes(word)));
  return DEVICE_CATEGORIES.map((category) => ({
    category,
    entries: matches.filter((entry) => entry.model.category === category),
  })).filter((group) => group.entries.length > 0);
}

function SearchField({ label, ...props }: { label: string } & ComponentProps<'input'>) {
  return (
    <div className="relative px-3 pb-3">
      <SearchIcon className="pointer-events-none absolute top-2 left-5.5 size-4 text-fg-3" />
      <Input placeholder={label} aria-label={label} className="pl-8" {...props} />
    </div>
  );
}

function DeviceItem({ entry: { model, summary } }: { entry: Entry }) {
  const onDragStart = (event: DragEvent) => {
    event.dataTransfer.setData(DEVICE_DRAG_TYPE, model.id);
    event.dataTransfer.effectAllowed = 'copy';
  };
  return (
    <li
      draggable
      tabIndex={0}
      onDragStart={onDragStart}
      data-model={model.id}
      className="flex cursor-grab items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors outline-none hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:ring-2 focus-visible:ring-accent/40 active:cursor-grabbing"
    >
      <DeviceIcon name={model.icon} className="size-6 shrink-0 text-fg-1" />
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-sm text-fg-1">{model.name}</span>
        <span className="truncate text-2xs text-fg-3">{summary}</span>
      </div>
    </li>
  );
}

function DeviceGroup({ category, entries }: { category: DeviceCategory; entries: Entry[] }) {
  const id = useId();
  return (
    <section className="flex flex-col gap-0.5 px-1.5 pb-3">
      <h3 id={id} className="px-2 pb-1 text-2xs font-semibold tracking-wide text-fg-3 uppercase">
        {CATEGORY_LABELS[category]}
      </h3>
      <ul aria-labelledby={id} className="flex flex-col gap-0.5">
        {entries.map((entry) => (
          <DeviceItem key={entry.model.id} entry={entry} />
        ))}
      </ul>
    </section>
  );
}

function DeviceCatalog() {
  const [query, setQuery] = useState('');
  const groups = filterCatalog(query);
  const info = SECTION_INFO.devices;
  return (
    <>
      <SearchField
        label={info.search}
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="min-h-0 flex-1 overflow-y-auto pt-1">
        {groups.length > 0 ? (
          groups.map((group) => <DeviceGroup key={group.category} {...group} />)
        ) : (
          <EmptyState icon={SearchIcon} title={info.empty}>
            {info.hint}
          </EmptyState>
        )}
      </div>
    </>
  );
}

export function PalettePanel({ section }: { section: PaletteSection }) {
  const info = SECTION_INFO[section];
  return (
    <aside aria-label="Device palette" className="flex h-full flex-col bg-surface-1">
      <div className="flex h-10 shrink-0 items-center px-3">
        <h2 className="text-xs font-semibold text-fg-1">{info.label}</h2>
      </div>
      {section === 'devices' ? (
        <DeviceCatalog />
      ) : (
        <>
          <SearchField label={info.search} disabled />
          <div className="min-h-0 flex-1 overflow-y-auto pt-1">
            <EmptyState icon={info.icon} title={info.empty}>
              {info.hint}
            </EmptyState>
          </div>
        </>
      )}
    </aside>
  );
}
