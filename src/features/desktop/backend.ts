import type { ArpTableEntry, PingOptions, PingReply } from '@/engine/api';
import type { DeviceId, Ipv4Address } from '@/model';

export type { ArpTableEntry, PingOptions, PingReply };

/**
 * Everything the Command Prompt asks of the network, in the engine's own types. `engineBackend.ts`
 * binds it to the simulation worker; tests pass their own. A method that cannot answer rejects
 * with an `Error` whose message the prompt prints.
 */
export interface HostBackend {
  /**
   * Sends `count` echo requests from `device`, calling `onReply` once per request as its answer
   * arrives. Resolves after the last one, or soon after `signal` aborts.
   */
  ping(
    device: DeviceId,
    target: Ipv4Address,
    options: PingOptions,
    onReply: (reply: PingReply) => void,
    signal: AbortSignal,
  ): Promise<void>;
  arpTable(device: DeviceId): Promise<ArpTableEntry[]>;
  clearArp(device: DeviceId): Promise<void>;
}
