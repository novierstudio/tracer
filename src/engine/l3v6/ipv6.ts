/* eslint-disable @typescript-eslint/no-unused-vars -- a placeholder until the module lands */
import type { Ipv6Address } from '@/model/ipv6';
import type { ModuleContext, SimModule } from '../module';
import type { PingListener, PingOptions } from '../l3/ping';
import type { TraceListener, TraceOptions } from '../l3/traceroute';
import type { Ipv6Status } from './status';

// Placeholder while the module is written: it runs nothing yet.
export type Ipv6State = { nextProbeId: number };
export type Ipv6Context = ModuleContext<Ipv6State>;

export const ipv6Module: SimModule<Ipv6State> = { id: 'ipv6', init: () => ({ nextProbeId: 1 }) };

export const ipv6Status = (ctx: Ipv6Context): Ipv6Status => ({
  routing: false,
  interfaces: [],
  routes: [],
  neighbors: [],
  ports: Object.fromEntries(ctx.device.ports.map((port) => [port.id, ctx.portUp(port.id)])),
});

export function startPing6(
  ctx: Ipv6Context,
  _target: Ipv6Address,
  _options: PingOptions,
  _listener: PingListener,
): number {
  return ctx.state.nextProbeId++;
}

export function startTrace6(
  ctx: Ipv6Context,
  _target: Ipv6Address,
  _options: TraceOptions,
  _listener: TraceListener,
): number {
  return ctx.state.nextProbeId++;
}

export function stopProbe6(_ctx: Ipv6Context, _id: number) {}
