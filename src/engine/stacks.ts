import { switchingModule } from './l2/switching';
import { ipModule } from './l3/ip';
import { ipv6Module } from './l3v6/ipv6';
import type { Stacks } from './module';
import { ospfModule } from './routing/ospf/ospf';
import { ripModule } from './routing/rip';

/** The protocol modules each kind of device runs in the app. Protocol layers register here. */
export const STACKS: Stacks = {
  router: [ipModule, ipv6Module, ripModule, ospfModule],
  switch: [switchingModule, ipModule],
  pc: [ipModule, ipv6Module],
  server: [ipModule, ipv6Module],
};
