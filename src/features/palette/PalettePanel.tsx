import { CableIcon, RouterIcon, SearchIcon, StickyNoteIcon, type LucideIcon } from 'lucide-react';
import { EmptyState } from '@/ui/empty-state';
import { Input } from '@/ui/input';

export const PALETTE_SECTIONS = ['devices', 'connections', 'annotate'] as const;
export type PaletteSection = (typeof PALETTE_SECTIONS)[number];

export const SECTION_INFO: Record<
  PaletteSection,
  { label: string; icon: LucideIcon; search: string; empty: string; hint: string }
> = {
  devices: {
    label: 'Devices',
    icon: RouterIcon,
    search: 'Search devices',
    empty: 'No devices yet',
    hint: 'Routers, switches, hubs, PCs, laptops and servers will be listed here, ready to drag onto the canvas.',
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

export function PalettePanel({ section }: { section: PaletteSection }) {
  const info = SECTION_INFO[section];
  return (
    <aside aria-label="Device palette" className="flex h-full flex-col bg-surface-1">
      <div className="flex h-10 shrink-0 items-center px-3">
        <h2 className="text-xs font-semibold text-fg-1">{info.label}</h2>
      </div>
      <div className="relative px-3 pb-3">
        <SearchIcon className="pointer-events-none absolute top-2 left-5.5 size-4 text-fg-3" />
        <Input disabled placeholder={info.search} aria-label={info.search} className="pl-8" />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pt-1">
        <EmptyState icon={info.icon} title={info.empty}>
          {info.hint}
        </EmptyState>
      </div>
    </aside>
  );
}
