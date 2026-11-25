import * as Comlink from 'comlink';
import { createEngine } from '@/engine/engine';
import { createSimService, type FrameClock } from '@/engine/service';
import { STACKS } from '@/engine/stacks';

const SEED = 1;

const frames: FrameClock = {
  now: () => performance.now(),
  request: (callback) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => callback());
    else setTimeout(callback, 16);
  },
};

Comlink.expose(createSimService({ engine: createEngine({ seed: SEED, stacks: STACKS }), frames }));
