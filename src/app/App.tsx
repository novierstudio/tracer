import { lazy, Suspense, type ComponentType } from 'react';
import { TooltipProvider } from '@/ui/tooltip';
import { useRoute, type Route } from './router';
import { Shell } from './shell/Shell';

function NotFound() {
  return (
    <main className="grid min-h-full place-content-center gap-2 p-4 text-center">
      <h1 className="text-base font-semibold">Page not found</h1>
      <a href="#/" className="text-accent-text underline-offset-2 hover:underline">
        Back to Tracer
      </a>
    </main>
  );
}

const PAGES: Record<Route, ComponentType> = {
  '/': Shell,
  '/dev/ui': lazy(() => import('./dev/UiGallery')),
  'not-found': NotFound,
};

export function App() {
  const Page = PAGES[useRoute()];
  return (
    <TooltipProvider delayDuration={400}>
      <Suspense>
        <Page />
      </Suspense>
    </TooltipProvider>
  );
}
