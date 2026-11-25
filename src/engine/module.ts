import type { Device, DeviceKind, LabSettings, PortId } from '@/model';
import type { SimDuration, SimTime } from './core/time';
import type { Frame } from './frame';

/** What a module can see and do on the device it runs on. */
export interface DeviceContext {
  readonly now: SimTime;
  /** The device as the simulation last received it. Read only. */
  readonly device: Device;
  /** The lab-wide settings the simulation last received. */
  readonly settings: LabSettings;
  portUp(port: PortId): boolean;
  /** Sends a frame out of a port. A port with no cable sends nothing. */
  send(port: PortId, frame: Frame): void;
  /** Fires `onTimer(key)` after `delay`. Setting a key again replaces its pending timer. */
  setTimer(key: string, delay: SimDuration): void;
  clearTimer(key: string): void;
  /** The run's seeded random stream, in [0, 1). Modules must not use Math.random. */
  random(): number;
  note(text: string): void;
}

export interface ModuleContext<S> extends DeviceContext {
  /**
   * This module's own state on this device. No other module or device can reach it. It must be
   * plain data (objects, arrays, Maps, Sets), since a snapshot copies it; callbacks are kept as is.
   */
  state: S;
}

/**
 * A protocol layer. The engine creates one instance per powered device whose stack lists the
 * module, and drops it, with its timers, when the device powers off or is deleted. Every hook
 * runs at the current simulated time and must be synchronous.
 */
export interface SimModule<S = unknown> {
  readonly id: string;
  /** Called when the device boots: on load, when it is added, and when it powers on. */
  init(ctx: DeviceContext): S;
  /** A frame arrived on a port. Every module in the device's stack sees every frame, in order. */
  onFrame?(ctx: ModuleContext<S>, port: PortId, frame: Frame): void;
  onTimer?(ctx: ModuleContext<S>, key: string): void;
  onLinkChange?(ctx: ModuleContext<S>, port: PortId, up: boolean): void;
  /**
   * The device's config or ports, or the lab's settings, may have changed. Re-derive what depends
   * on them.
   */
  onConfigChange?(ctx: ModuleContext<S>): void;
  /**
   * The device is powering off or leaving the simulation, and this instance is about to be
   * dropped. Settle what waits on it. It must not send or set timers, and the device may be gone.
   */
  onStop?(ctx: ModuleContext<S>): void;
  /**
   * Whether the module holds an up port back from forwarding frames, as spanning tree does until
   * the port forwards. The port's end of its link shows as held while any module says so.
   */
  holdsPort?(ctx: ModuleContext<S>, port: PortId): boolean;
}

/** Why a module cannot run on a device: no such device, it is off, or its kind does not run the module. */
export type DeviceUnavailable = 'unknown-device' | 'powered-off' | 'unsupported';

/** The modules each kind of device runs, in the order they see frames. */
export type Stacks = Readonly<Record<DeviceKind, readonly SimModule[]>>;
