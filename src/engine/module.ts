import type {
  Device,
  DeviceKind,
  InterfaceId,
  Ipv4Address,
  LabSettings,
  MacAddress,
  PortId,
  StoredFile,
  VlanDatabase,
  VlanId,
} from '@/model';
import type { SimDuration, SimTime } from './core/time';
import type { Frame } from './frame';
import type { LearnedRoute } from './l3/routes';

/** A server service that keeps files. */
export type FileService = 'tftp' | 'ftp';

/** What a module can see and do on the device it runs on. */
export interface DeviceContext {
  readonly now: SimTime;
  /** The device as the simulation last received it. Read only. */
  readonly device: Device;
  /** The lab-wide settings the simulation last received. */
  readonly settings: LabSettings;
  portUp(port: PortId): boolean;
  /**
   * Whether the port is up and forwards `vlan`'s frames: no module holds it back in that VLAN, as
   * spanning tree does on a port that is not forwarding. A switch's VLAN interface uses only these.
   */
  forwards(port: PortId, vlan: VlanId): boolean;
  /**
   * The bundle a port is bundled into now, as an EtherChannel member is into its port-channel, or
   * undefined. A frame flooded out of a bundle leaves by one member only.
   */
  bundleOf(port: PortId): string | undefined;
  /** Sends a frame out of a port. A port with no cable sends nothing. */
  send(port: PortId, frame: Frame): void;
  /** Fires `onTimer(key)` after `delay`. Setting a key again replaces its pending timer. */
  setTimer(key: string, delay: SimDuration): void;
  clearTimer(key: string): void;
  /** The run's seeded random stream, in [0, 1). Modules must not use Math.random. */
  random(): number;
  note(text: string): void;
  /** Prints a message on the device's console, as IOS logs `%LINK-3-UPDOWN: ...`. */
  syslog(text: string): void;
  /** Adds a sticky secure address to the port's config, as IOS writes it into the running-config. */
  learnSticky(port: PortId, mac: MacAddress): void;
  /** Stores a VTP update's VLANs and revision in the switch's config, as IOS writes vlan.dat. */
  storeVlans(database: VlanDatabase): void;
  /**
   * A server's TFTP or FTP files changed, as an upload changes them: they belong in its config,
   * so they show in its Services tab and save with the lab.
   */
  learnFiles(service: FileService, files: readonly StoredFile[]): void;
  /** A module's `disablesPort` answer changed: bring the device's links in line with it. */
  relink(): void;
  /** The routes every module on the device offers now, for its routing table. See `routes`. */
  learnedRoutes(): readonly LearnedRoute[];
  /** The virtual addresses every module answers for now. See `virtualAddresses`. */
  virtualAddresses(): readonly VirtualAddress[];
}

/**
 * An address an interface answers for besides its own, as an active HSRP router does for its
 * group's virtual IP and MAC: it replies to ARP for the IP and takes frames sent to the MAC.
 */
export type VirtualAddress = {
  readonly interface: InterfaceId;
  readonly address: Ipv4Address;
  readonly mac: MacAddress;
};

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
  /**
   * The device's ports share one half-duplex segment, as a hub's do: while the engine detects
   * collisions, frames that reach two of its ports at the same instant collide and none arrives.
   */
  readonly sharedMedium?: true;
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
  /** The device logged a console message, as `syslog` does, for example to send it to a server. */
  onSyslog?(ctx: ModuleContext<S>, text: string): void;
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
  /**
   * Whether the module has taken the port down, as IOS err-disables one: its link is down at both
   * ends while any module says so. Call `relink` when the answer changes.
   */
  disablesPort?(ctx: ModuleContext<S>, port: PortId): boolean;
  /** The bundle the module has bundled the port into, if any. See `bundleOf`. */
  bundleOf?(ctx: ModuleContext<S>, port: PortId): string | undefined;
  /** Whether the module holds an up port back from forwarding `vlan`'s frames. See `forwards`. */
  holdsVlan?(ctx: ModuleContext<S>, port: PortId, vlan: VlanId): boolean;
  /**
   * The routes the module has learned and offers the device's routing table now, as a routing
   * protocol does. The table weighs them against connected and static routes, and against each
   * other, by administrative distance then metric. It must not call `learnedRoutes`.
   */
  routes?(ctx: ModuleContext<S>): readonly LearnedRoute[];
  /**
   * The virtual addresses the module answers for now, as HSRP does while active. The device's IP
   * layer replies to ARP for them and takes their frames. It must not call `virtualAddresses`.
   */
  virtualAddresses?(ctx: ModuleContext<S>): readonly VirtualAddress[];
}

/** Why a module cannot run on a device: no such device, it is off, or its kind does not run the module. */
export type DeviceUnavailable = 'unknown-device' | 'powered-off' | 'unsupported';

/** The modules each kind of device runs, in the order they see frames. */
export type Stacks = Readonly<Record<DeviceKind, readonly SimModule[]>>;
