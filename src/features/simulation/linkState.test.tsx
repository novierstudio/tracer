import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { SimEventBatch } from '@/engine/api';
import type { BatchListener } from '@/engine/client';
import type { SimTime } from '@/engine/core/time';
import { useLinkLights } from '@/features/canvas/lights';
import type { LinkId } from '@/model';
import { trackLinkStates } from './linkState';

const lnk1 = 'lnk_1' as LinkId;
const lnk2 = 'lnk_2' as LinkId;

/** Stands in for the worker client: link states so far, and a way to send it a batch. */
function fakeClient(initial: Record<LinkId, boolean>) {
  const listeners = new Set<BatchListener>();
  const client = {
    linkStates: () => initial,
    onBatch: (listener: BatchListener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
  const send = (links: Record<LinkId, boolean>) => {
    const batch: SimEventBatch = {
      now: 0 as SimTime,
      mode: 'realtime',
      playing: true,
      events: [],
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
    const { client } = fakeClient({ [lnk1]: true, [lnk2]: false });
    stop = trackLinkStates(client);

    expect(renderHook(() => useLinkLights(lnk1)).result.current).toEqual({ a: 'up', b: 'up' });
    expect(renderHook(() => useLinkLights(lnk2)).result.current).toEqual({ a: 'down', b: 'down' });
  });

  it('follows each batch, so a shut-down port turns its link light red', () => {
    const { client, send } = fakeClient({ [lnk1]: true });
    stop = trackLinkStates(client);
    const { result } = renderHook(() => useLinkLights(lnk1));

    send({ [lnk1]: false });
    expect(result.current).toEqual({ a: 'down', b: 'down' });

    send({ [lnk1]: true });
    expect(result.current).toEqual({ a: 'up', b: 'up' });
  });

  it('leaves a link the engine has not reported on unknown', () => {
    const { client } = fakeClient({ [lnk1]: true });
    stop = trackLinkStates(client);

    expect(renderHook(() => useLinkLights('lnk_new' as LinkId)).result.current).toEqual({
      a: 'unknown',
      b: 'unknown',
    });
  });
});
