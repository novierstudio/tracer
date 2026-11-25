import { createStore } from 'zustand/vanilla';
import { readJson, safeStorage } from '@/app/storage';

const STORAGE_KEY = 'tracer.onboarding';

/** One sample lab's "Try this" checklist: the steps ticked, by index. */
export type Checklist = { done: readonly number[]; dismissed: boolean };

type Saved = {
  welcomeDismissed: boolean;
  checklists: Record<string, Checklist>;
};

export type OnboardingState = Saved & {
  /** Show welcome asked for the card this session, even over a lab with devices. */
  welcomeRequested: boolean;
  galleryOpen: boolean;
};

function readSaved(): Saved {
  const saved = readJson(STORAGE_KEY, (value): Partial<Saved> | undefined =>
    typeof value === 'object' && value !== null ? value : undefined,
  );
  return {
    welcomeDismissed: saved?.welcomeDismissed === true,
    checklists:
      typeof saved?.checklists === 'object' && saved.checklists !== null ? saved.checklists : {},
  };
}

export type OnboardingStore = ReturnType<typeof createOnboardingStore>;

export function createOnboardingStore() {
  const store = createStore<OnboardingState>()(() => ({
    ...readSaved(),
    welcomeRequested: false,
    galleryOpen: false,
  }));
  store.subscribe((next, prev) => {
    if (next.welcomeDismissed === prev.welcomeDismissed && next.checklists === prev.checklists) {
      return;
    }
    const saved: Saved = { welcomeDismissed: next.welcomeDismissed, checklists: next.checklists };
    safeStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
  });

  const setChecklist = (id: string, update: (checklist: Checklist) => Checklist) =>
    store.setState(({ checklists }) => ({
      checklists: {
        ...checklists,
        [id]: update(checklists[id] ?? { done: [], dismissed: false }),
      },
    }));

  return {
    store,
    dismissWelcome: () => store.setState({ welcomeDismissed: true, welcomeRequested: false }),
    showWelcome: () => store.setState({ welcomeRequested: true }),
    /** The card has done its job for now: a lab opened, or the gallery took over. */
    releaseWelcome: () => store.setState({ welcomeRequested: false }),
    openGallery: () => store.setState({ galleryOpen: true }),
    closeGallery: () => store.setState({ galleryOpen: false }),
    /** A freshly opened sample starts its checklist over. */
    startChecklist: (id: string) => setChecklist(id, () => ({ done: [], dismissed: false })),
    toggleStep: (id: string, step: number) =>
      setChecklist(id, (checklist) => ({
        ...checklist,
        done: checklist.done.includes(step)
          ? checklist.done.filter((done) => done !== step)
          : [...checklist.done, step].sort((a, b) => a - b),
      })),
    dismissChecklist: (id: string) =>
      setChecklist(id, (checklist) => ({ ...checklist, dismissed: true })),
  };
}

export const onboarding = createOnboardingStore();
