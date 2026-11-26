import { addressOf } from '@/engine/l3/hostAddress';
import type { RemoteStack } from '@/features/terminal/remote';
import type { TerminalSession } from '@/features/terminal/session';
import { hostFiles } from '@/model/defaults';
import { isIpv6 } from '@/model/ipv6';
import type { HostBackend, PingReply, TraceProbe } from './backend';
import { HELP, parseCommand } from './commands';
import { formatDir } from './files';
import {
  addressPort,
  configAddressing,
  configIpv6,
  formatArp,
  formatIpconfig,
  formatIpv6config,
  formatNslookup,
  formatReply,
  liveIpv6,
  pingHeader,
  pingSummary,
  tracertHeader,
  tracertLines,
  type HostDevice,
  type HostIpv6View,
  type IpconfigView,
} from './format';

/** Where a running command writes. `signal` aborts on Ctrl+C. */
export type ShellIo = {
  print(lines: readonly string[]): void;
  /** Writes part of a line, or more. `\n` breaks lines. */
  write(text: string): void;
  clear(): void;
  /**
   * Hands the keyboard to `session`, a remote login, until `done`: what it prints shows here and
   * the keys typed go to it.
   */
  attach(session: TerminalSession, done: Promise<void>): Promise<void>;
  readonly signal: AbortSignal;
};

/** The host as the prompt sees it when a line runs. Undefined once the device is gone. */
export type HostView = { device: HostDevice; connected: boolean };

/** `wallClock` dates a DHCP lease's times for `ipconfig /all`; it is the real clock by default. */
export type ShellContext = {
  host(): HostView | undefined;
  backend: HostBackend;
  wallClock?: () => number;
  /** A fresh stack for a Telnet or SSH login. Without one, the prompt cannot log in anywhere. */
  remote?: () => RemoteStack;
};

/** A command line, run to completion. */
export type HostShell = (line: string, io: ShellIo) => Promise<void>;

const PING_TIMEOUT_MS = 4000;

/** Windows tracert sends 3 probes per hop. */
const TRACERT_PROBES = 3;

/** Every line ends with a blank one before the next prompt, as in cmd. */
const block = (lines: readonly string[]) => (lines.at(-1) === '' ? lines : [...lines, '']);

/** Resolves on Ctrl+C, including one pressed before the command got this far. */
const aborted = (signal: AbortSignal) =>
  signal.aborted
    ? Promise.resolve()
    : new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      );

/** What Windows says to `/release` or `/renew` on an adapter that does not use DHCP. */
const NOT_DHCP = [
  '',
  'The operation failed as no adapter is in the state permissible for this operation.',
  '',
];

export function hostShell({
  host,
  backend,
  wallClock = Date.now,
  remote,
}: ShellContext): HostShell {
  return async (line, io) => {
    const parsed = parseCommand(line);
    if (!parsed.ok) return io.print(block(parsed.error));
    const command = parsed.value;
    const view = host();
    if (!view) return;
    const { device, connected } = view;
    const dhcp = device.config.ipv4.mode === 'dhcp';
    /** The host's addressing now. A static host's is its config; a DHCP host's, the simulation's. */
    const live = async (): Promise<IpconfigView> => {
      if (!dhcp) return { addressing: configAddressing(device), dateOf: (time) => new Date(time) };
      const { addressing, now } = await backend.hostIp(device.id);
      const wall = wallClock();
      return { addressing, dateOf: (time) => new Date(wall - (now - time)) };
    };
    /**
     * The host's IPv6 now. A static host's is its config; a SLAAC host's, the simulation's, or
     * its link-local address alone when the simulation cannot say.
     */
    const ipv6 = async (): Promise<HostIpv6View | undefined> => {
      const port = addressPort(device);
      if (!port) return undefined;
      if (device.config.ipv6?.mode !== 'auto') return configIpv6(device, port);
      return backend.ipv6Status(device.id).then(
        (status) => liveIpv6(status, port),
        () => configIpv6(device, port),
      );
    };
    const ipconfig = async (all: boolean) => {
      if (!connected) return formatIpconfig(device, connected, all);
      const [view, v6] = await Promise.all([live(), ipv6()]);
      return formatIpconfig(device, connected, all, { ...view, ...(v6 && { ipv6: v6 }) });
    };
    /** `/release` and `/renew` need a DHCP adapter with its cable in. */
    const dhcpRefusal = () => {
      if (!dhcp) return NOT_DHCP;
      const port = addressPort(device);
      if (connected || !port) return undefined;
      return [
        '',
        `No operation can be performed on ${port.id} while it has its media disconnected.`,
        '',
      ];
    };
    try {
      // An IPv6 ping or trace needs no IPv4 address: the host always has its link-local one.
      const needsIpv4 =
        command.kind === 'arp-show' ||
        ((command.kind === 'ping' || command.kind === 'tracert') && !isIpv6(command.target));
      const address = needsIpv4 ? addressOf((await live()).addressing) : undefined;
      const ready = !needsIpv4 || address !== undefined;
      switch (command.kind) {
        case 'empty':
          return;
        case 'help':
          return io.print(HELP);
        case 'cls':
          return io.clear();
        case 'dir':
          return io.print(formatDir(hostFiles(device.config)));
        case 'ipconfig':
          return io.print(await ipconfig(command.all));
        case 'ipv6config':
          return io.print(
            formatIpv6config(device, connected, command.all, connected ? await ipv6() : undefined),
          );
        case 'ipconfig-release': {
          const refusal = dhcpRefusal();
          if (refusal) return io.print(refusal);
          await backend.releaseDhcp(device.id);
          return io.print(await ipconfig(false));
        }
        case 'ipconfig-renew': {
          const refusal = dhcpRefusal();
          if (refusal) return io.print(refusal);
          // Ctrl+C gives the prompt back; the client carries on asking.
          const outcome = await Promise.race([backend.renewDhcp(device.id), aborted(io.signal)]);
          if (!outcome) return io.print(['^C', '']);
          if (outcome.kind === 'failed') {
            return io.print([
              '',
              `An error occurred while renewing interface ${addressPort(device)?.id} : unable to contact your DHCP server. Request has timed out.`,
              '',
            ]);
          }
          return io.print(await ipconfig(false));
        }
        case 'arp-show':
          return io.print(formatArp(address?.address, await backend.arpTable(device.id)));
        case 'arp-clear': {
          const cleared = await backend.clearArp(device.id, command.address);
          if (command.address && cleared === 0) {
            return io.print(['The ARP entry deletion failed: Element not found.', '']);
          }
          return io.print(['']);
        }
        case 'nslookup': {
          // Ctrl+C gives the prompt back; the lookup times out in the simulation on its own.
          const lookup = await Promise.race([
            backend.nslookup(device.id, command.name, command.server),
            aborted(io.signal),
          ]);
          return io.print(lookup ? formatNslookup(lookup) : ['^C', '']);
        }
        case 'ping': {
          if (!ready) return io.print(['PING: transmit failed. General failure.', '']);
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
        case 'remote': {
          if (!remote) return io.print(['% Unable to connect: no network.', '']);
          const stack = remote();
          const user = command.protocol === 'ssh' ? { user: command.user } : {};
          const request = { protocol: command.protocol, target: command.target, ...user };
          const output = stack.hooks.connect(device.id, request);
          // Ctrl+C while connecting gives the prompt back.
          void aborted(io.signal).then(() => output.abort());
          await output.start((text) => io.write(text));
          if (stack.depth === 0 || io.signal.aborted) return;
          await Promise.race([io.attach(stack.session, stack.emptied()), aborted(io.signal)]);
          // The device went away mid-session: hang up whatever is still open.
          while (stack.depth > 0) stack.hooks.disconnect();
          return;
        }
        case 'tracert': {
          if (!ready) return io.print(['Unable to contact IP driver. General failure.', '']);
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
