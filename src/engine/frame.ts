import type { DeviceId } from '@/model';
import type { EthernetFrame, HdlcFrame } from './pdu';

/**
 * Everything that can cross a link. Frames are plain, structured-cloneable values: they cross to
 * the main thread in the event log and drive the PDU inspector. Never edit a frame after sending
 * it; build a new one. Protocol layers add their variants to this union.
 */
export type Frame = HelloFrame | EthernetFrame | HdlcFrame;

/** The engine's link test frame. It carries no protocol and proves that a frame crosses a link. */
export type HelloFrame = {
  readonly kind: 'hello';
  readonly origin: DeviceId;
  readonly seq: number;
};
