import { LayoutGridIcon, SparklesIcon } from 'lucide-react';
import type { Command } from '@/features/command/registry';
import { onboarding } from './store';

export const ONBOARDING_COMMANDS: readonly Command[] = [
  {
    id: 'onboarding.samples',
    title: 'Open sample lab…',
    group: 'File',
    keywords: ['example', 'template', 'gallery', 'tutorial', 'demo', 'lab'],
    icon: LayoutGridIcon,
    run: onboarding.openGallery,
  },
  {
    id: 'onboarding.welcome',
    title: 'Show welcome',
    group: 'Help',
    keywords: ['getting started', 'intro', 'onboarding', 'start', 'help'],
    icon: SparklesIcon,
    run: onboarding.showWelcome,
  },
];
