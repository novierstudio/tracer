import {
  PALETTE_SECTIONS,
  SECTION_INFO,
  type PaletteSection,
} from '@/features/palette/PalettePanel';
import { Button } from '@/ui/button';
import { Tooltip } from '@/ui/tooltip';

type RailProps = {
  active: PaletteSection | null;
  onSelect: (section: PaletteSection) => void;
  inert: boolean;
};

export function Rail({ active, onSelect, inert }: RailProps) {
  return (
    <nav
      aria-label="Palette sections"
      inert={inert}
      className="flex w-11 shrink-0 flex-col items-center gap-1 border-r border-line bg-surface-1 py-2"
    >
      {PALETTE_SECTIONS.map((section) => {
        const { label, icon: Icon } = SECTION_INFO[section];
        return (
          <Tooltip key={section} label={label} side="right">
            <Button
              variant="ghost"
              size="icon"
              aria-label={label}
              aria-pressed={active === section}
              onClick={() => onSelect(section)}
            >
              <Icon strokeWidth={1.75} className="size-[18px]" />
            </Button>
          </Tooltip>
        );
      })}
    </nav>
  );
}
