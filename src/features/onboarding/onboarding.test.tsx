import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SAMPLE_LABS, deviceCount } from '@/labs/catalog';
import { OnboardingLayer } from './OnboardingLayer';
import SampleGallery from './SampleGallery';
import { createOnboardingStore } from './store';

beforeEach(() => localStorage.clear());

describe('onboarding store', () => {
  it('remembers that the welcome was dismissed, in a fresh store as after a reload', () => {
    expect(createOnboardingStore().store.getState().welcomeDismissed).toBe(false);
    createOnboardingStore().dismissWelcome();
    expect(createOnboardingStore().store.getState().welcomeDismissed).toBe(true);
  });

  it('remembers ticked steps, and starts a checklist over when its sample opens again', () => {
    const first = createOnboardingStore();
    first.toggleStep('two-pcs-switch', 2);
    first.toggleStep('two-pcs-switch', 0);
    expect(createOnboardingStore().store.getState().checklists['two-pcs-switch']?.done).toEqual([
      0, 2,
    ]);

    const second = createOnboardingStore();
    second.toggleStep('two-pcs-switch', 2);
    second.dismissChecklist('two-pcs-switch');
    expect(second.store.getState().checklists['two-pcs-switch']).toEqual({
      done: [0],
      dismissed: true,
    });
    second.startChecklist('two-pcs-switch');
    expect(second.store.getState().checklists['two-pcs-switch']).toEqual({
      done: [],
      dismissed: false,
    });
  });

  it('ignores a corrupt saved value', () => {
    localStorage.setItem('tracer.onboarding', '{"welcomeDismissed":"yes","checklists":7}');
    const { store } = createOnboardingStore();
    expect(store.getState()).toMatchObject({ welcomeDismissed: false, checklists: {} });
  });
});

describe('sample gallery', () => {
  it('lists every sample lab with its difficulty and device count, and opens the one clicked', () => {
    const onOpenLab = vi.fn(() => Promise.resolve());
    render(<SampleGallery open onOpenChange={() => {}} onOpenLab={onOpenLab} />);
    const cards = within(screen.getByRole('list', { name: 'Sample labs' })).getAllByRole('button');
    expect(cards).toHaveLength(SAMPLE_LABS.length);
    SAMPLE_LABS.forEach((lab, index) => {
      expect(cards[index]).toHaveTextContent(lab.title);
      expect(cards[index]).toHaveTextContent(`${deviceCount(lab)} devices`);
      expect(cards[index]).toHaveTextContent(/Beginner|Intermediate/);
    });

    fireEvent.click(screen.getByRole('button', { name: /Router on a stick/ }));
    expect(onOpenLab).toHaveBeenCalledWith(SAMPLE_LABS.find((l) => l.id === 'router-on-a-stick'));
  });
});

describe('welcome card', () => {
  it('shows on an empty lab and goes away when closed', async () => {
    render(<OnboardingLayer />);
    const welcome = await screen.findByRole('region', { name: 'Welcome to Tracer' });
    expect(within(welcome).getByRole('button', { name: /Open a sample lab/ })).toBeVisible();

    fireEvent.click(within(welcome).getByRole('button', { name: 'Close welcome' }));
    expect(screen.queryByRole('region', { name: 'Welcome to Tracer' })).toBeNull();
    expect(createOnboardingStore().store.getState().welcomeDismissed).toBe(true);
  });
});
