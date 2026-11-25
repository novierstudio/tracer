import type { DeviceId, Ipv4Address, MacAddress } from '@/model';

/** What came back for one echo request. */
export type PingReply =
  | { kind: 'reply'; from: Ipv4Address; bytes: number; timeMs: number; ttl: number }
  | { kind: 'timeout' }
  | { kind: 'unreachable'; from: Ipv4Address };

export type PingOptions = { count: number; timeoutMs: number };

export type ArpEntry = { address: Ipv4Address; mac: MacAddress; type: 'dynamic' | 'static' };

/**
 * Everything the Command Prompt asks of the network. The app's backend lives in `engineBackend.ts`;
 * `mockBackend.ts` stands in for it in tests and in builds that set `window.__TRACER_MOCK_HOST__`.
 * A method that cannot answer rejects with an `Error` whose message the prompt prints.
 */
export interface HostBackend {
  /**
   * Sends up to `count` echo requests from `device`, calling `onReply` once per request as its
   * answer arrives. Resolves after the last one, or soon after `signal` aborts.
   */
  ping(
    device: DeviceId,
    target: Ipv4Address,
    options: PingOptions,
    onReply: (reply: PingReply) => void,
    signal: AbortSignal,
  ): Promise<void>;
  arpTable(device: DeviceId): Promise<ArpEntry[]>;
  clearArp(device: DeviceId): Promise<void>;
}
