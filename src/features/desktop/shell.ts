import type { HostBackend, PingReply, TraceProbe } from './backend';
import { HELP, parseCommand } from './commands';
import {
  formatArp,
  formatIpconfig,
  formatReply,
  pingHeader,
  pingSummary,
  tracertHeader,
  tracertLines,
  type HostDevice,
} from './format';

/** Where a running command writes. `signal` aborts on Ctrl+C. */
export type ShellIo = {
  print(lines: readonly string[]): void;
  /** Writes part of a line, or more. `\n` breaks lines. */
  write(text: string): void;
  clear(): void;
  readonly signal: AbortSignal;
};

/** The host as the prompt sees it when a line runs. Undefined once the device is gone. */
export type HostView = { device: HostDevice; connected: boolean };

export type ShellContext = { host(): HostView | undefined; backend: HostBackend };

/** A command line, run to completion. */
export type HostShell = (line: string, io: ShellIo) => Promise<void>;

const PING_TIMEOUT_MS = 4000;

/** Windows tracert sends 3 probes per hop. */
const TRACERT_PROBES = 3;

/** Every line ends with a blank one before the next prompt, as in cmd. */
const block = (lines: readonly string[]) => (lines.at(-1) === '' ? lines : [...lines, '']);

const aborted = (signal: AbortSignal) =>
  new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));

export function hostShell({ host, backend }: ShellContext): HostShell {
  return async (line, io) => {
    const parsed = parseCommand(line);
    if (!parsed.ok) return io.print(block(parsed.error));
    const command = parsed.value;
    const view = host();
    if (!view) return;
    const { device, connected } = view;
    const address = device.config.ipv4.mode === 'static' ? device.config.ipv4.address : undefined;
    try {
      switch (command.kind) {
        case 'empty':
          return;
        case 'help':
          return io.print(HELP);
        case 'cls':
          return io.clear();
        case 'ipconfig':
          return io.print(formatIpconfig(device, connected, command.all));
        case 'arp-show':
          return io.print(formatArp(address?.address, await backend.arpTable(device.id)));
        case 'arp-clear': {
          const cleared = await backend.clearArp(device.id, command.address);
          if (command.address && cleared === 0) {
            return io.print(['The ARP entry deletion failed: Element not found.', '']);
          }
          return io.print(['']);
        }
        case 'ping': {
          if (!address) return io.print(['PING: transmit failed. General failure.', '']);
          io.print(pingHeader(command.target));
          const replies: PingReply[] = [];
          const onReply = (reply: PingReply) => {
            if (io.signal.aborted) return;
            replies.push(reply);
            io.print([formatReply(reply)]);
          };
          const options = { count: command.count, timeoutMs: PING_TIMEOUT_MS };
          // Ctrl+C returns the prompt now, whenever the backend gets round to stopping.
          await Promise.race([
            backend.ping(device.id, command.target, options, onReply, io.signal),
            aborted(io.signal),
          ]);
          io.print(pingSummary(command.target, replies));
          return io.print(io.signal.aborted ? ['Control-C', '^C', ''] : ['']);
        }
        case 'tracert': {
          if (!address) return io.print(['Unable to contact IP driver. General failure.', '']);
          const { target, maxHops, timeoutMs } = command;
          io.print(tracertHeader(target, maxHops));
          const lines = tracertLines(TRACERT_PROBES);
          const onProbe = (probe: TraceProbe) => {
            if (!io.signal.aborted) io.write(lines.next(probe));
          };
          const options = { maxHops, probesPerHop: TRACERT_PROBES, timeoutMs };
          await Promise.race([
            backend.traceroute(device.id, target, options, onProbe, io.signal),
            aborted(io.signal),
          ]);
          io.write(lines.close());
          return io.print(io.signal.aborted ? ['^C', ''] : ['', 'Trace complete.', '']);
        }
      }
    } catch (error) {
      io.print(block([error instanceof Error ? error.message : String(error)]));
    }
  };
}
