import type { ArpTableEntry, PingOptions, PingReply, TraceOptions, TraceProbe } from '@/engine/api';
import type { DeviceId, Ipv4Address } from '@/model';

export type { ArpTableEntry, PingOptions, PingReply, TraceOptions, TraceProbe };

/**
 * Everything the Command Prompt asks of the network, in the engine's own types. `engineBackend.ts`
 * binds it to the simulation worker; tests pass their own. A method that cannot answer rejects
 * with an `Error` whose message the prompt prints.
 */
export interface HostBackend {
  /**
   * Sends `count` echo requests from `device`, calling `onReply` once per request as its answer
   * arrives. Resolves after the last one. Aborting `signal` stops the ping in the simulation and
   * resolves soon after.
   */
  ping(
    device: DeviceId,
    target: Ipv4Address,
    options: PingOptions,
    onReply: (reply: PingReply) => void,
    signal: AbortSignal,
  ): Promise<void>;
  /**
   * Traces the route from `device` to `target`, calling `onProbe` once per probe as it settles.
   * Resolves when the trace is done. Aborting `signal` stops it as it does a ping.
   */
  traceroute(
    device: DeviceId,
    target: Ipv4Address,
    options: TraceOptions,
    onProbe: (probe: TraceProbe) => void,
    signal: AbortSignal,
  ): Promise<void>;
  arpTable(device: DeviceId): Promise<ArpTableEntry[]>;
  /** Forgets `address`, or every learned address. Resolves with how many entries went. */
  clearArp(device: DeviceId, address?: Ipv4Address): Promise<number>;
}
