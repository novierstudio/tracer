import type { Device, OspfArea, OspfConfig } from '@/model';
import { ms, type SimDuration } from '../../core/time';
import { routingDevice, type RoutingDevice } from '../../l3/interfaces';
import type { DeviceContext, ModuleContext } from '../../module';
import { OSPF_TIMERS } from '../timers';
import type { OspfState } from './state';
import type { OspfNeighborState } from './status';

export type OspfContext = ModuleContext<OspfState>;
export type Router = RoutingDevice;

/** Interface cost is this many kbit/s divided by the interface's bandwidth: 100 Mbit/s. */
export const REFERENCE_BANDWIDTH = 100_000;

/** Each router refreshes its own LSAs this often, in seconds, so none ages out while it lives. */
export const LS_REFRESH_TIME = 1800;

export const seconds = (value: number): SimDuration => ms(value * 1000);
export const timersOf = (ctx: DeviceContext) => OSPF_TIMERS[ctx.settings.routingTimers];
export const ospfConfig = (device: Device): OspfConfig | undefined =>
  routingDevice(device)?.config.ospf;

/** What `area <id>` commands set for the area, if any. */
export const areaSettings = (config: OspfConfig, area: number): OspfArea | undefined =>
  config.areas?.find((entry) => entry.area === area);

/** Whether the area is a stub area: `area <id> stub`, with or without `no-summary`. */
export const isStub = (config: OspfConfig, area: number): boolean =>
  areaSettings(config, area)?.stub !== undefined;

/** Whether the router redistributes routes into OSPF, which makes it an AS boundary router. */
export const isBoundary = (config: OspfConfig): boolean =>
  config.redistributeStatic !== undefined ||
  config.redistributeConnected !== undefined ||
  config.defaultOriginate !== undefined;

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
