import { CableIcon, RouterIcon, SearchIcon, StickyNoteIcon, type LucideIcon } from 'lucide-react';
import {
  useId,
  useState,
  type ComponentProps,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import {
  CATEGORY_LABELS,
  DEVICE_GROUPS,
  DEVICE_MODELS,
  portSummary,
  type DeviceCategory,
  type DeviceModel,
  type DeviceModelId,
} from '@/devices/catalog';
import { DeviceIcon } from '@/devices/icons';
import { formatShortcut } from '@/app/shell/shortcuts';
import { ANNOTATION_TOOLS, type AnnotationTool } from '@/features/canvas/annotations';
import { addAnnotationAt, placeDevice, viewCentre } from '@/features/canvas/controller';
import { EmptyState } from '@/ui/empty-state';
import { Input } from '@/ui/input';

export const PALETTE_SECTIONS = ['devices', 'connections', 'annotate'] as const;
export type PaletteSection = (typeof PALETTE_SECTIONS)[number];

/** The drop payload is the catalog model id. */
export const DEVICE_DRAG_TYPE = 'application/x-tracer-device';
/** The drop payload is the annotation tool, such as `area`. */
export const ANNOTATION_DRAG_TYPE = 'application/x-tracer-annotation';

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
    empty: 'No matching annotations',
    hint: 'Click to add one mid-view, or drag it to a spot. B and O draw an area box or ellipse by dragging on the canvas.',
  },
};

type Entry = { model: DeviceModel; summary: string; haystack: string };

const GROUP_LABELS = new Map<DeviceCategory, string>(
  DEVICE_GROUPS.flatMap((group) => group.categories.map((category) => [category, group.label])),
);

const ENTRIES: Entry[] = DEVICE_MODELS.map((model) => {
  const summary = portSummary(model);
  const words = [
    model.name,
    GROUP_LABELS.get(model.category),
    CATEGORY_LABELS[model.category],
    model.hostnamePrefix,
    summary,
  ];
  return { model, summary, haystack: words.join(' ').toLowerCase() };
});

type CategoryMatches = { category: DeviceCategory; entries: Entry[] };

/**
 * Palette groups in order, each with its categories that have an entry matching every word of
 * the query. Empty categories and groups are left out.
 */
export function filterCatalog(query: string): { label: string; categories: CategoryMatches[] }[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = ENTRIES.filter((entry) => words.every((word) => entry.haystack.includes(word)));
  return DEVICE_GROUPS.map((group) => ({
    label: group.label,
    categories: group.categories
      .map((category) => ({
        category,
        entries: matches.filter((entry) => entry.model.category === category),
      }))
      .filter((matches) => matches.entries.length > 0),
  })).filter((group) => group.categories.length > 0);
}

function SearchField({ label, ...props }: { label: string } & ComponentProps<'input'>) {
  return (
    <div className="relative px-3 pb-3">
      <SearchIcon className="pointer-events-none absolute top-2 left-5.5 size-4 text-fg-3" />
      <Input placeholder={label} aria-label={label} className="pl-8" {...props} />
    </div>
  );
}

type PaletteItemProps = {
  name: string;
  summary: string;
  icon: ReactNode;
  drag: { type: string; payload: string };
  onAdd: () => void;
};

// Clicking, or Enter on a focused item, drops the item in the middle of the canvas view.
function PaletteItem({ name, summary, icon, drag, onAdd }: PaletteItemProps) {
  const onDragStart = (event: DragEvent) => {
    event.dataTransfer.setData(drag.type, drag.payload);
    event.dataTransfer.effectAllowed = 'copy';
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    onAdd();
  };
  return (
    <li
      draggable
      tabIndex={0}
      title={`Click to add ${name}, or drag it onto the canvas`}
      onDragStart={onDragStart}
      onClick={onAdd}
      onKeyDown={onKeyDown}
      className="flex cursor-grab items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors outline-none hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:ring-2 focus-visible:ring-accent/40 active:cursor-grabbing"
    >
      {icon}
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-sm text-fg-1">{name}</span>
        <span className="truncate text-2xs text-fg-3">{summary}</span>
      </div>
    </li>
  );
}

function DeviceItem({ entry: { model, summary } }: { entry: Entry }) {
  return (
    <PaletteItem
      name={model.name}
      summary={summary}
      icon={<DeviceIcon name={model.icon} className="size-6 shrink-0 text-fg-1" />}
      drag={{ type: DEVICE_DRAG_TYPE, payload: model.id }}
      onAdd={() => placeDevice(model.id as DeviceModelId)}
    />
  );
}

const ANNOTATE_GROUPS: { title: string; tools: AnnotationTool[] }[] = [
  { title: 'Text', tools: ['note', 'text'] },
  { title: 'Regions and shapes', tools: ['area', 'rectangle', 'ellipse'] },
];

function AnnotationItem({ tool }: { tool: AnnotationTool }) {
  const { label, summary, icon: Icon, shortcut } = ANNOTATION_TOOLS[tool];
  return (
    <PaletteItem
      name={label}
      summary={shortcut ? `${summary} · ${formatShortcut(shortcut)}` : summary}
      icon={
        <span className="flex size-6 shrink-0 items-center justify-center">
          <Icon className={tool === 'note' ? 'size-5 text-warn' : 'size-5 text-fg-2'} />
        </span>
      }
      drag={{ type: ANNOTATION_DRAG_TYPE, payload: tool }}
      onAdd={() => {
        const at = viewCentre();
        if (at) addAnnotationAt(tool, at);
      }}
    />
  );
}

function AnnotateGroup({ title, tools }: { title: string; tools: AnnotationTool[] }) {
  const id = useId();
  return (
    <section className="flex flex-col gap-0.5 px-1.5 pb-3">
      <h3 id={id} className="px-2 pb-1 text-2xs font-semibold tracking-wide text-fg-3 uppercase">
        {title}
      </h3>
      <ul aria-labelledby={id} className="flex flex-col gap-0.5">
        {tools.map((tool) => (
          <AnnotationItem key={tool} tool={tool} />
        ))}
      </ul>
    </section>
  );
}

function Annotations() {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto pt-1">
      {ANNOTATE_GROUPS.map((group) => (
        <AnnotateGroup key={group.title} {...group} />
      ))}
      <p className="px-5 text-2xs text-balance text-fg-3">{SECTION_INFO.annotate.hint}</p>
    </div>
  );
}

function CategoryList({ category, entries }: CategoryMatches) {
  const id = useId();
  return (
    <section className="flex flex-col gap-0.5 px-1.5 pb-3">
      <h4 id={id} className="px-2 pb-1 text-2xs font-semibold tracking-wide text-fg-3 uppercase">
        {CATEGORY_LABELS[category]}
      </h4>
      <ul aria-labelledby={id} className="flex flex-col gap-0.5">
        {entries.map((entry) => (
          <DeviceItem key={entry.model.id} entry={entry} />
        ))}
      </ul>
    </section>
  );
}

function DeviceGroup({ label, categories }: { label: string; categories: CategoryMatches[] }) {
  return (
    <section className="flex flex-col pb-1">
      <h3 className="px-3.5 pb-1.5 text-xs font-semibold text-fg-2">{label}</h3>
      {categories.map((matches) => (
        <CategoryList key={matches.category} {...matches} />
      ))}
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
          groups.map((group) => <DeviceGroup key={group.label} {...group} />)
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
      ) : section === 'annotate' ? (
        <Annotations />
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
