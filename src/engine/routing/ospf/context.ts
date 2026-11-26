import type { Device, OspfConfig } from '@/model';
import { ms, type SimDuration } from '../../core/time';
import type { DeviceContext, ModuleContext } from '../../module';
import { OSPF_TIMERS } from '../timers';
import type { OspfState } from './state';
import type { OspfNeighborState } from './status';

export type OspfContext = ModuleContext<OspfState>;
export type Router = Extract<Device, { kind: 'router' }>;

/** Interface cost is this many kbit/s divided by the interface's bandwidth: 100 Mbit/s. */
export const REFERENCE_BANDWIDTH = 100_000;

/** Each router refreshes its own LSAs this often, in seconds, so none ages out while it lives. */
export const LS_REFRESH_TIME = 1800;

export const seconds = (value: number): SimDuration => ms(value * 1000);
export const timersOf = (ctx: DeviceContext) => OSPF_TIMERS[ctx.settings.routingTimers];
export const ospfConfig = (device: Device): OspfConfig | undefined =>
  device.kind === 'router' ? device.config.ospf : undefined;

export const STATE_NAMES: Record<OspfNeighborState, string> = {
  down: 'DOWN',
  init: 'INIT',
  '2way': '2WAY',
  exstart: 'EXSTART',
  exchange: 'EXCHANGE',
  loading: 'LOADING',
  full: 'FULL',
};

export const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
