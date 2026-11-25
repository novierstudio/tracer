import type { DeviceId, Endpoint, LinkId, PortId } from '@/model';
import type { SimTime } from './core/time';
import type { Frame } from './frame';

declare const eventIdBrand: unique symbol;

/** Position of an event in the run's log. Starts at 1 and grows by one per event. */
export type EventId = number & { readonly [eventIdBrand]: true };

export type FrameOutcome = 'delivered' | 'link-down';

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

export type SimEvent = FrameEvent | LinkEvent | NoteEvent;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type NewEvent = DistributiveOmit<SimEvent, 'id'>;
