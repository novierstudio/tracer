import type {
  ChannelMode,
  Ipv4Address,
  MacAddress,
  PortId,
  PortSecurityViolation,
  VirtualInterfaceId,
  VlanId,
} from '@/model';
import type { ChannelProtocol } from '@/model/l2';
import type { SimTime } from '../core/time';
import type { DeviceCapability } from '../pdu';

/** A CDP neighbour, as `show cdp neighbors` lists it: one per local port it was heard on. */
export type CdpNeighbor = {
  readonly deviceId: string;
  readonly localPort: PortId;
  /** Seconds left before the entry expires. */
  readonly holdtime: number;
  readonly capabilities: readonly DeviceCapability[];
  readonly platform: string;
  /** The neighbour's port, in full. */
  readonly portId: string;
  readonly addresses: readonly Ipv4Address[];
  readonly software: string;
  readonly version: number;
  readonly nativeVlan?: VlanId;
  readonly duplex: 'full' | 'half';
};

export type CdpStatus = {
  /** `cdp run`, on unless the config turns it off. */
  readonly enabled: boolean;
  /** Seconds between advertisements, and how long neighbours keep them. */
  readonly timer: number;
  readonly holdtime: number;
  /** Ports CDP runs on: Ethernet and serial ports without `no cdp enable`. */
  readonly interfaces: readonly PortId[];
  readonly neighbors: readonly CdpNeighbor[];
};

export type LldpNeighbor = {
  readonly chassisId: MacAddress;
  readonly localPort: PortId;
  /** Seconds left before the entry expires. */
  readonly holdtime: number;
  readonly ttl: number;
  readonly portId: string;
  readonly systemName: string;
  readonly systemDescription: string;
  readonly capabilities: readonly DeviceCapability[];
  readonly managementAddress?: Ipv4Address;
  /** The neighbour's port VLAN, as `show lldp neighbors detail` prints it. */
  readonly vlan?: VlanId;
};

export type LldpStatus = {
  /** `lldp run`, off unless the config turns it on. */
  readonly enabled: boolean;
  readonly timer: number;
  readonly holdtime: number;
  readonly neighbors: readonly LldpNeighbor[];
};

/** What a router or switch's CDP and LLDP know now. */
export type DiscoveryStatus = { readonly cdp: CdpStatus; readonly lldp: LldpStatus };

/**
 * A member port's state in `show etherchannel summary`: bundled (P), stand-alone (I) for a port
 * whose partner does not negotiate, suspended (s) for one that cannot join, down (D), or waiting
 * (w) to be aggregated.
 */
export type ChannelPortFlag = 'P' | 'I' | 's' | 'D' | 'w';

export type ChannelMember = {
  readonly port: PortId;
  readonly mode: ChannelMode;
  readonly flag: ChannelPortFlag;
  /** When it last joined the bundle. */
  readonly bundledAt?: SimTime;
};

export type EtherChannelStatus = {
  readonly group: number;
  /** Undefined for mode `on`. */
  readonly protocol: ChannelProtocol | undefined;
  /** Some member is bundled: the port-channel is up (U). */
  readonly inUse: boolean;
  /** When the port-channel came up. */
  readonly upSince?: SimTime;
  readonly members: readonly ChannelMember[];
};

export type SecureAddressType = 'static' | 'sticky' | 'dynamic';

export type SecureAddressEntry = {
  readonly port: PortId;
  readonly vlan: VlanId;
  readonly mac: MacAddress;
  readonly type: SecureAddressType;
  /** Minutes before it ages out, for a port with `aging time`. */
  readonly remainingAge?: number;
};

/** `Secure-up`, `Secure-down` while the link is down, or `Secure-shutdown` once err-disabled. */
export type SecurePortState = 'secure-up' | 'secure-down' | 'secure-shutdown';

export type PortSecurityStatus = {
  readonly port: PortId;
  readonly state: SecurePortState;
  readonly maximum: number;
  readonly violation: PortSecurityViolation;
  readonly violations: number;
  readonly lastSource?: { readonly mac: MacAddress; readonly vlan: VlanId };
  readonly addresses: readonly SecureAddressEntry[];
};

/** A port err-disabled for a port security violation, and when recovery brings it back. */
export type ErrDisabledPort = {
  readonly port: PortId;
  readonly cause: 'psecure-violation';
  readonly recoverAt?: SimTime;
};

/** A switch's EtherChannels and port security as they run now. */
export type SwitchL2Status = {
  readonly etherchannels: readonly EtherChannelStatus[];
  readonly portSecurity: readonly PortSecurityStatus[];
  readonly errDisabled: readonly ErrDisabledPort[];
};

/** What `show vtp status` reads from VTP as it runs, beyond the config. */
export type VtpStatus = {
  /** Who made the change the VLAN database is at: 0.0.0.0 until one. */
  readonly lastModifiedBy: Ipv4Address;
  /** When, as `yymmddhhmmss`: all zeros until a change. */
  readonly lastModifiedAt: string;
  /** The lowest-numbered VLAN interface that has an address and is up, which a change here carries. */
  readonly localUpdater?: { readonly interface: VirtualInterfaceId; readonly address: Ipv4Address };
};

/**
 * Everything layer 2 beyond switching, for the show commands of CDP, LLDP, EtherChannel, port
 * security and VTP. A router has no EtherChannels, secure ports or VTP.
 */
export type Layer2Status = DiscoveryStatus &
  SwitchL2Status & {
    readonly vtp?: VtpStatus;
    /** Whether each port's link is up now. */
    readonly ports: Readonly<Partial<Record<PortId, boolean>>>;
    /** The simulated clock, for the ages show commands print. */
    readonly clock: SimTime;
  };
