import { MonitorIcon, MoonIcon, SunIcon, type LucideIcon } from 'lucide-react';
import { Button } from '@/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';
import { Tooltip } from '@/ui/tooltip';
import { THEME_PREFS, parseThemePref, setThemePref, useThemePref, type ThemePref } from './theme';

const THEME_OPTIONS: Record<ThemePref, { label: string; icon: LucideIcon }> = {
  light: { label: 'Light', icon: SunIcon },
  dark: { label: 'Dark', icon: MoonIcon },
  system: { label: 'System', icon: MonitorIcon },
};

export function ThemeMenu() {
  const pref = useThemePref();
  const Icon = THEME_OPTIONS[pref].icon;
  return (
    <DropdownMenu>
      <Tooltip label="Theme">
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label="Theme">
            <Icon />
          </Button>
        </DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuContent align="end" className="min-w-36">
        <DropdownMenuLabel>Theme</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={pref}
          onValueChange={(value) => setThemePref(parseThemePref(value))}
        >
          {THEME_PREFS.map((value) => {
            const { label, icon: ItemIcon } = THEME_OPTIONS[value];
            return (
              <DropdownMenuRadioItem key={value} value={value}>
                <ItemIcon />
                {label}
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
