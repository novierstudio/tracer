import type { DeviceKind } from '@/model';
import { ms, type SimDuration } from './core/time';
import type { SimModule, Stacks } from './module';

export function stacksOf(modules: Partial<Record<DeviceKind, readonly SimModule[]>>): Stacks {
  return { router: [], switch: [], pc: [], server: [], ...modules };
}

const noteHooks = {
  onLinkChange: (ctx, port, up) => ctx.note(`${port} ${up ? 'up' : 'down'}`),
  onConfigChange: (ctx) => ctx.note('config changed'),
  onFrame: (ctx, port, frame) => {
    if (frame.kind === 'hello') ctx.note(`hello ${frame.seq} from ${frame.origin} on ${port}`);
  },
} satisfies Partial<SimModule<unknown>>;

/** Receives frames and notes every hook. Never sends. */
export const listenerModule: SimModule<null> = { id: 'listener', init: () => null, ...noteHooks };

/**
 * Sends a hello frame out of every port when the device boots, then every `period` plus up to
 * `jitter` of seeded randomness. Without a period it sends once.
 */
export function helloModule({
  period,
  jitter = ms(0),
}: { period?: SimDuration; jitter?: SimDuration } = {}): SimModule<{ seq: number }> {
  return {
    id: 'hello',
    init: (ctx) => {
      ctx.setTimer('hello', ms(0));
      return { seq: 0 };
    },
    onTimer: (ctx) => {
      ctx.state.seq += 1;
      for (const port of ctx.device.ports) {
        ctx.send(port.id, { kind: 'hello', origin: ctx.device.id, seq: ctx.state.seq });
      }
      if (period !== undefined) ctx.setTimer('hello', ms(period + ctx.random() * jitter));
    },
    ...noteHooks,
  };
}
