import { shallow } from 'zustand/shallow';
import type { SimClient } from '@/engine/client';
import { linkLights, type LinkLights } from '@/features/canvas/lights';
import type { LinkId } from '@/model';

// Both ends show the link's state for now. Per-end states, such as amber while STP listens,
// come with spanning tree.
const UP: LinkLights = { a: 'up', b: 'up' };
const DOWN: LinkLights = { a: 'down', b: 'down' };

/**
 * Feeds the engine's link states to the canvas's link lights, from the client's latest batch and
 * then from every batch after it. Returns a function that stops it.
 */
export function trackLinkStates(client: Pick<SimClient, 'linkStates' | 'onBatch'>): () => void {
  let shown: Readonly<Record<LinkId, boolean>> | undefined;
  const show = (links: Readonly<Record<LinkId, boolean>>) => {
    if (shown && shallow(shown, links)) return;
    shown = links;
    const lights = Object.entries(links).map(([id, up]) => [id, up ? UP : DOWN]);
    linkLights.setState(Object.fromEntries(lights) as Record<LinkId, LinkLights>, true);
  };
  show(client.linkStates());
  return client.onBatch((batch) => show(batch.links));
}
