import { switchingModule } from './l2/switching';
import type { Stacks } from './module';

/** The protocol modules each kind of device runs in the app. Protocol layers register here. */
export const STACKS: Stacks = { router: [], switch: [switchingModule], pc: [], server: [] };
