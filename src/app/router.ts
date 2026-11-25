import { useSyncExternalStore } from 'react';

export const ROUTES = ['/', '/dev/ui'] as const;
export type Route = (typeof ROUTES)[number] | 'not-found';

// Only `#/…` hashes are routes. Other hashes (such as a future `#t=` share link) belong to the shell.
export function parseHash(hash: string): Route {
  if (!hash.startsWith('#/')) return '/';
  const path = hash
    .slice(1)
    .split('?')[0]!
    .replace(/(.)\/+$/, '$1');
  return ROUTES.find((route) => route === path) ?? 'not-found';
}

function subscribe(onChange: () => void) {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
}

export function useRoute(): Route {
  return useSyncExternalStore(subscribe, () => parseHash(window.location.hash));
}
