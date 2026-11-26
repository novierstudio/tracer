import { switchingModule } from './l2/switching';
import { ipModule } from './l3/ip';
import type { Stacks } from './module';
import { ospfModule } from './routing/ospf/ospf';
import { ripModule } from './routing/rip';

/** The protocol modules each kind of device runs in the app. Protocol layers register here. */
export const STACKS: Stacks = {
  router: [ipModule, ripModule, ospfModule],
  switch: [switchingModule, ipModule],
  pc: [ipModule],
  server: [ipModule],
};
