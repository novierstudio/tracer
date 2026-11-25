import { expect, it } from 'vitest';
import { parseHash } from './router';

it('maps an empty or root hash to the shell', () => {
  expect(parseHash('')).toBe('/');
  expect(parseHash('#')).toBe('/');
  expect(parseHash('#/')).toBe('/');
});

it('maps the gallery hash, tolerating a trailing slash and a query', () => {
  expect(parseHash('#/dev/ui')).toBe('/dev/ui');
  expect(parseHash('#/dev/ui/')).toBe('/dev/ui');
  expect(parseHash('#/dev/ui?theme=dark')).toBe('/dev/ui');
});

it('leaves non-route hashes to the shell', () => {
  expect(parseHash('#t=eJyrVkrLz1eyUlAqSs1LSS1SqgUAMLIFUQ')).toBe('/');
});

it('reports unknown routes', () => {
  expect(parseHash('#/nope')).toBe('not-found');
});
