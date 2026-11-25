import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import type { LinkId } from '@/model';

/** What a link light shows. Every light is grey (`unknown`) until the engine reports link state. */
export type LinkLight = 'unknown' | 'up' | 'pending' | 'down';
export type LinkLights = { a: LinkLight; b: LinkLight };

const UNKNOWN: LinkLights = { a: 'unknown', b: 'unknown' };

/** The simulation engine writes each link's lights here. The canvas only reads them. */
export const linkLights = createStore<Partial<Record<LinkId, LinkLights>>>(() => ({}));

export function useLinkLights(link: LinkId): LinkLights {
  return useStore(linkLights, (lights) => lights[link] ?? UNKNOWN);
}
