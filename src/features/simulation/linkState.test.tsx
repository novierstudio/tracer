import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { LinkStatus, SimEventBatch } from '@/engine/api';
import type { BatchListener } from '@/engine/client';
import type { SimTime } from '@/engine/core/time';
import type { EventId } from '@/engine/events';
import { useLinkLights } from '@/features/canvas/lights';
import type { LinkId } from '@/model';
import { trackLinkStates } from './linkState';

const lnk1 = 'lnk_1' as LinkId;
const lnk2 = 'lnk_2' as LinkId;

const UP: LinkStatus = { a: 'up', b: 'up' };
const DOWN: LinkStatus = { a: 'down', b: 'down' };

/** Stands in for the worker client: link states so far, and a way to send it a batch. */
function fakeClient(initial: Record<LinkId, LinkStatus>) {
  const listeners = new Set<BatchListener>();
  const client = {
    linkStates: () => initial,
    onBatch: (listener: BatchListener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
  const send = (links: Record<LinkId, LinkStatus>) => {
    const batch: SimEventBatch = {
      now: 0 as SimTime,
      mode: 'realtime',
      playing: true,
      events: [],
      head: 0 as EventId,
      canStepBack: false,
      links,
    };
    act(() => listeners.forEach((listener) => listener(batch)));
  };
  return { client, send };
}

let stop: (() => void) | undefined;
afterEach(() => stop?.());

describe('trackLinkStates', () => {
  it('lights both ends of each link from the states the client already has', () => {
    const { client } = fakeClient({ [lnk1]: UP, [lnk2]: DOWN });
    stop = trackLinkStates(client);

    expect(renderHook(() => useLinkLights(lnk1)).result.current).toEqual({ a: 'up', b: 'up' });
    expect(renderHook(() => useLinkLights(lnk2)).result.current).toEqual({ a: 'down', b: 'down' });
  });

  it('follows each batch, so a shut-down port turns its link light red', () => {
    const { client, send } = fakeClient({ [lnk1]: UP });
    stop = trackLinkStates(client);
    const { result } = renderHook(() => useLinkLights(lnk1));

    send({ [lnk1]: DOWN });
    expect(result.current).toEqual({ a: 'down', b: 'down' });

    send({ [lnk1]: UP });
    expect(result.current).toEqual({ a: 'up', b: 'up' });
  });

  it('lights an end amber while spanning tree holds it, and green once it forwards', () => {
    const { client, send } = fakeClient({ [lnk1]: { a: 'up', b: 'held' } });
    stop = trackLinkStates(client);
    const { result } = renderHook(() => useLinkLights(lnk1));

    expect(result.current).toEqual({ a: 'up', b: 'pending' });

    send({ [lnk1]: UP });
    expect(result.current).toEqual({ a: 'up', b: 'up' });
  });

  it('keeps the lights of a link that did not change, so its cable does not redraw', () => {
    const { client, send } = fakeClient({ [lnk1]: UP, [lnk2]: DOWN });
    stop = trackLinkStates(client);
    const { result } = renderHook(() => useLinkLights(lnk1));
    const before = result.current;

    send({ [lnk1]: { a: 'up', b: 'up' }, [lnk2]: UP });
    expect(result.current).toBe(before);
  });

  it('leaves a link the engine has not reported on unknown', () => {
    const { client } = fakeClient({ [lnk1]: UP });
    stop = trackLinkStates(client);

    expect(renderHook(() => useLinkLights('lnk_new' as LinkId)).result.current).toEqual({
      a: 'unknown',
      b: 'unknown',
    });
  });
});
