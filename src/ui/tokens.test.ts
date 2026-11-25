import { describe, expect, it } from 'vitest';
import css from './tokens.css?raw';

function tokensFor(selector: RegExp): Record<string, string> {
  const block = css.match(selector)?.[1];
  if (!block) throw new Error(`No token block matches ${selector}`);
  return Object.fromEntries(
    [...block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6});/gi)].map((m) => [m[1]!, m[2]!]),
  );
}

function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

const themes = {
  light: tokensFor(/:root,\s*\.light\s*{([^}]*)}/),
  dark: tokensFor(/\n\.dark\s*{([^}]*)}/),
};

const AA = 4.5;
const pairs: [fg: string, bg: string][] = [
  ...['text-1', 'text-2', 'text-3', 'accent-text'].flatMap((fg) =>
    ['surface-0', 'surface-1', 'surface-2'].map((bg): [string, string] => [fg, bg]),
  ),
  ...['ok', 'warn', 'err'].flatMap((fg) =>
    ['surface-0', 'surface-1'].map((bg): [string, string] => [fg, bg]),
  ),
  ['accent-fg', 'accent'],
];

describe.each(Object.entries(themes))('%s theme', (_, tokens) => {
  it.each(pairs)('%s on %s meets WCAG AA', (fg, bg) => {
    expect(tokens[fg], fg).toBeDefined();
    expect(tokens[bg], bg).toBeDefined();
    expect(contrast(tokens[fg]!, tokens[bg]!)).toBeGreaterThanOrEqual(AA);
  });

  it('defines the same token names as the light theme', () => {
    expect(Object.keys(tokens).sort()).toEqual(Object.keys(themes.light).sort());
  });
});
