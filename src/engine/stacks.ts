import { switchingModule } from './l2/switching';
import { ipModule } from './l3/ip';
import type { Stacks } from './module';

/** The protocol modules each kind of device runs in the app. Protocol layers register here. */
export const STACKS: Stacks = {
  router: [ipModule],
  switch: [switchingModule],
  pc: [ipModule],
  server: [ipModule],
};
