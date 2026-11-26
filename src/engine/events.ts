import type {
  DeviceId,
  Endpoint,
  LinkId,
  MacAddress,
  PortId,
  StoredFile,
  VlanDatabase,
} from '@/model';
import type { SimTime } from './core/time';
import type { Frame } from './frame';

declare const eventIdBrand: unique symbol;

/** Position of an event in the run's log. Starts at 1 and grows by one per event. */
export type EventId = number & { readonly [eventIdBrand]: true };

/** `collision`: it reached a shared segment, such as a hub, at the same instant as another frame. */
export type FrameOutcome = 'delivered' | 'link-down' | 'collision';

/** A frame a device sent out of one of its ports. */
export type SentFrame = { readonly port: PortId; readonly frame: Frame };

/** One frame on one link, logged when its fate is known: on arrival, or at once if the link is down. */
export type FrameEvent = {
  kind: 'frame';
  id: EventId;
  time: SimTime;
  sentAt: SimTime;
  link: LinkId;
  from: Endpoint;
  to: Endpoint;
  frame: Frame;
  outcome: FrameOutcome;
  /**
   * What the receiving device sent while it handled the frame, in order: a forwarded copy, a
   * reply, an error. Empty when it kept or dropped the frame. Only delivered frames have it.
   */
  sent?: readonly SentFrame[];
};

export type LinkEvent = { kind: 'link'; id: EventId; time: SimTime; link: LinkId; up: boolean };

/** A line a module wrote about what it did, such as "learned a MAC address". */
export type NoteEvent = {
  kind: 'note';
  id: EventId;
  time: SimTime;
  device: DeviceId;
  module: string;
  text: string;
};

/** A message a router or switch printed on its console, such as `%LINK-3-UPDOWN: ...`. */
export type SyslogEvent = {
  kind: 'syslog';
  id: EventId;
  time: SimTime;
  device: DeviceId;
  text: string;
};

/** A switch learned a sticky secure address, which belongs in the port's running-config. */
export type StickyMacEvent = {
  kind: 'sticky-mac';
  id: EventId;
  time: SimTime;
  device: DeviceId;
  port: PortId;
  mac: MacAddress;
};

/** A switch took a VTP update, whose VLANs and revision belong in its config. */
export type VlanDatabaseEvent = {
  kind: 'vlan-database';
  id: EventId;
  time: SimTime;
  device: DeviceId;
  database: VlanDatabase;
};

/** A server's TFTP or FTP files changed, as an upload changes them, which belongs in its config. */
export type ServerFilesEvent = {
  kind: 'server-files';
  id: EventId;
  time: SimTime;
  device: DeviceId;
  service: 'tftp' | 'ftp';
  /** Every file the service now keeps, in order. */
  files: readonly StoredFile[];
};

export type SimEvent =
  | FrameEvent
  | LinkEvent
  | NoteEvent
  | SyslogEvent
  | StickyMacEvent
  | VlanDatabaseEvent
  | ServerFilesEvent;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type NewEvent = DistributiveOmit<SimEvent, 'id'>;
