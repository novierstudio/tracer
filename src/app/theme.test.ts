import { expect, it } from 'vitest';
import { parseThemePref, resolveTheme } from './theme';

it('falls back to the system theme for missing or unknown stored values', () => {
  expect(parseThemePref(null)).toBe('system');
  expect(parseThemePref('sepia')).toBe('system');
  expect(parseThemePref('dark')).toBe('dark');
});

it('follows the OS only when the preference is system', () => {
  expect(resolveTheme('system', true)).toBe('dark');
  expect(resolveTheme('system', false)).toBe('light');
  expect(resolveTheme('light', true)).toBe('light');
  expect(resolveTheme('dark', false)).toBe('dark');
});
