import { lazy, Suspense, type ComponentType } from 'react';
import { TooltipProvider } from '@/ui/tooltip';
import iconUrl from '../../assets/icon.svg';
import { useRoute, type Route } from './router';

function Home() {
  return (
    <main className="grid min-h-full place-content-center justify-items-center gap-3 p-4 text-center">
      <img src={iconUrl} width={96} height={96} alt="" />
      <h1 className="text-4xl font-semibold">Tracer</h1>
      <p className="text-fg-2">
        Tracer is an independent project and is not affiliated with or endorsed by Cisco Systems.
      </p>
    </main>
  );
}

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
  '/': Home,
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
