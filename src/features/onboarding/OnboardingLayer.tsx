import { lazy, Suspense, useEffect, useState } from 'react';
import { useStore } from 'zustand';
import { useRegisterCommands } from '@/features/command/registry';
import { fileSession } from '@/features/files/session';
import { useEditor } from '@/model/react';
import { editorStore } from '@/model/store';
import { cn } from '@/ui/cn';
import { ONBOARDING_COMMANDS } from './commands';
import { onboarding } from './store';
import { WelcomeCard } from './WelcomeCard';

const SampleGallery = lazy(() => import('./SampleGallery'));
const TryThisCard = lazy(() => import('./TryThisCard'));

/** False until the last lab is back, so a returning user's lab never flashes the welcome. */
function useRestored() {
  const [restored, setRestored] = useState(false);
  useEffect(() => {
    let live = true;
    // The file session starts in a sibling's effect, which runs in this same flush: wait a tick.
    void Promise.resolve()
      .then(() => fileSession.restored())
      .then(() => live && setRestored(true));
    return () => {
      live = false;
    };
  }, []);
  return restored;
}

/** True while a device is dragged from the palette, so the welcome card steps out of the way. */
function useDragging() {
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    const start = () => setDragging(true);
    const end = () => setDragging(false);
    window.addEventListener('dragstart', start);
    window.addEventListener('dragend', end);
    window.addEventListener('drop', end);
    return () => {
      window.removeEventListener('dragstart', start);
      window.removeEventListener('dragend', end);
      window.removeEventListener('drop', end);
    };
  }, []);
  return dragging;
}

/** The welcome card, the sample gallery and the open sample's checklist, over the canvas. */
export function OnboardingLayer() {
  const state = useStore(onboarding.store);
  const empty = useEditor((editor) => Object.keys(editor.topology.devices).length === 0);
  const restored = useRestored();
  const dragging = useDragging();

  useRegisterCommands(ONBOARDING_COMMANDS);

  // A welcome asked for over a lab gives way as soon as the lab changes.
  useEffect(
    () =>
      editorStore.subscribe((next, prev) => {
        if (next.topology !== prev.topology) onboarding.releaseWelcome();
      }),
    [],
  );

  const welcome = state.welcomeRequested || (restored && empty && !state.welcomeDismissed);

  const startBlank = () => {
    onboarding.dismissWelcome();
    if (!empty) void fileSession.newLab();
  };

  return (
    <>
      {welcome && (
        <div
          className={cn(
            'pointer-events-none absolute inset-0 z-10 flex items-center justify-center p-4 transition-opacity duration-150 @container',
            dragging && 'opacity-0 *:pointer-events-none!',
          )}
        >
          <WelcomeCard
            onStartBlank={startBlank}
            onOpenSamples={onboarding.openGallery}
            onImport={() => void fileSession.open()}
            onDismiss={onboarding.dismissWelcome}
          />
        </div>
      )}
      <Suspense>
        <TryThisCard hidden={welcome} />
      </Suspense>
      {state.galleryOpen && (
        <Suspense>
          <SampleGallery open onOpenChange={(open) => !open && onboarding.closeGallery()} />
        </Suspense>
      )}
    </>
  );
}
