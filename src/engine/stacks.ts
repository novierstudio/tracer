import { discoveryModule } from './l2/discovery';
import { switchingModule } from './l2/switching';
import { ipModule } from './l3/ip';
import { ipv6Module } from './l3v6/ipv6';
import type { Stacks } from './module';
import { eigrpModule } from './routing/eigrp/eigrp';
import { ospfModule } from './routing/ospf/ospf';
import { ripModule } from './routing/rip';

/** The protocol modules each kind of device runs in the app. Protocol layers register here. */
export const STACKS: Stacks = {
  router: [ipModule, ipv6Module, ripModule, ospfModule, eigrpModule, discoveryModule],
  switch: [switchingModule, ipModule, discoveryModule],
  pc: [ipModule, ipv6Module],
  server: [ipModule, ipv6Module],
};
