import { shallow } from 'zustand/shallow';
import type { LinkEnd, LinkStatus } from '@/engine/api';
import type { SimClient } from '@/engine/client';
import { linkLights, type LinkLight, type LinkLights } from '@/features/canvas/lights';
import type { LinkId } from '@/model';

/** A port spanning tree holds back shows amber, as Packet Tracer shows it, until it forwards. */
const LIGHT: Record<LinkEnd, LinkLight> = { down: 'down', up: 'up', held: 'pending' };

/**
 * Feeds the engine's link states to the canvas's link lights, from the client's latest batch and
 * then from every batch after it. A link whose lights did not change keeps its object, so its
 * cable does not redraw. Returns a function that stops it.
 */
export function trackLinkStates(client: Pick<SimClient, 'linkStates' | 'onBatch'>): () => void {
  let shown: Partial<Record<LinkId, LinkLights>> = {};
  const show = (links: Readonly<Record<LinkId, LinkStatus>>) => {
    const next: Partial<Record<LinkId, LinkLights>> = {};
    for (const [id, { a, b }] of Object.entries(links) as [LinkId, LinkStatus][]) {
      const before = shown[id];
      next[id] =
        before?.a === LIGHT[a] && before.b === LIGHT[b] ? before : { a: LIGHT[a], b: LIGHT[b] };
    }
    if (shallow(shown, next)) return;
    shown = next;
    linkLights.setState(next, true);
  };
  show(client.linkStates());
  return client.onBatch((batch) => show(batch.links));
}
