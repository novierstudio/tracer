import { useSyncExternalStore } from 'react';
import { safeStorage } from './storage';

export const THEME_PREFS = ['light', 'dark', 'system'] as const;
export type ThemePref = (typeof THEME_PREFS)[number];
export type Theme = Exclude<ThemePref, 'system'>;

// index.html reads the same key before first paint to avoid a theme flash.
export const THEME_STORAGE_KEY = 'tracer.theme';

const darkQuery = () => window.matchMedia('(prefers-color-scheme: dark)');

export function parseThemePref(value: string | null): ThemePref {
  return THEME_PREFS.find((pref) => pref === value) ?? 'system';
}

export function resolveTheme(pref: ThemePref, systemDark: boolean): Theme {
  if (pref !== 'system') return pref;
  return systemDark ? 'dark' : 'light';
}

let pref: ThemePref = parseThemePref(safeStorage.getItem(THEME_STORAGE_KEY));
const listeners = new Set<() => void>();

function apply() {
  const theme = resolveTheme(pref, darkQuery().matches);
  const root = document.documentElement;
  root.classList.toggle('dark', theme === 'dark');
  root.classList.toggle('light', theme === 'light');
}

export function setThemePref(next: ThemePref) {
  pref = next;
  safeStorage.setItem(THEME_STORAGE_KEY, next);
  apply();
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const query = darkQuery();
  const onSystemChange = () => {
    apply();
    listener();
  };
  query.addEventListener('change', onSystemChange);
  return () => {
    listeners.delete(listener);
    query.removeEventListener('change', onSystemChange);
  };
}

export function useThemePref(): ThemePref {
  return useSyncExternalStore(subscribe, () => pref);
}
