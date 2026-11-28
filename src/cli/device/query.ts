import type {
  AclHits,
  ArpTableEntry,
  DeviceUnavailable,
  DhcpBindingEntry,
  HsrpGroupStatus,
  Ipv6Status,
  Layer2Status,
  MacTableEntry,
  NatTranslationEntry,
  NtpStatus,
  PingListener,
  PingOptions,
  ProbeHandle,
  Route,
  RoutingProtocols,
  SpanningTreeVlan,
  TftpListener,
  TftpRequest,
  TraceListener,
  TraceOptions,
} from '../../engine/api';
import { ok, type Ipv4Address, type PortId, type RemoteProtocol, type Result } from '../../model';
import type { IpAddress } from '../../model/ipv6';
import type { ConfigFile, IosDevice } from './context';
import { pingOutput } from './ping';
import { tftpOutput } from './tftp';
import { tracerouteOutput } from './traceroute';

/** Whether each port's link is up, as the simulation sees it. */
export type PortStates = Readonly<Partial<Record<PortId, boolean>>>;

/** A Telnet or SSH session open on one of a device's vty lines. */
export type VtySession = {
  /** 0 to 15, as in `line vty 0 15`. */
  readonly line: number;
  readonly protocol: RemoteProtocol;
  readonly peer: Ipv4Address;
  /** Who logged in, when the line asked for a username. */
  readonly user?: string;
};

/** The live state a show command can ask the simulation for, by kind, and what it gets back. */
export interface EngineAnswers {
  readonly routes: readonly Route[];
  readonly arp: readonly ArpTableEntry[];
  readonly macTable: readonly MacTableEntry[];
  readonly ports: PortStates;
  /** The device's clock and its NTP associations, for `show clock` and `show ntp`. */
  readonly ntp: NtpStatus;
  readonly spanningTree: readonly SpanningTreeVlan[];
  /** A router's DHCP leases in force. */
  readonly dhcpBindings: readonly DhcpBindingEntry[];
  readonly protocols: RoutingProtocols;
  readonly aclHits: AclHits;
  readonly natTranslations: readonly NatTranslationEntry[];
  /** `clear ip nat translation *`: how many translations it cleared. Asking clears them. */
  readonly natCleared: number;
  readonly ipv6: Ipv6Status;
  /** The Telnet and SSH sessions open on the device's vty lines, for `show users`. */
  readonly sessions: readonly VtySession[];
  /** CDP, LLDP, EtherChannel and port security as they run now. */
  readonly layer2: Layer2Status;
  /** HSRP groups as they run now, for `show standby`. */
  readonly standby: readonly HsrpGroupStatus[];
}

export type EngineQueryKind = keyof EngineAnswers;

/**
 * Prints a show command from live state. With no simulation to ask, `answer` is undefined and the
 * output comes from the config alone.
 */
export type Render<K extends EngineQueryKind, D extends IosDevice = IosDevice> = (
  answer: EngineAnswers[K] | undefined,
  device: D,
) => readonly string[];

/**
 * A show command waiting on live state. The session prints its config-only output at once; a
 * terminal that can reach the simulation asks it for `kind` and prints `render(answer)` instead.
 */
export type EngineQuery<K extends EngineQueryKind = EngineQueryKind> = {
  readonly [P in K]: {
    readonly kind: P;
    readonly render: (answer: EngineAnswers[P]) => readonly string[];
  };
}[K];

/** A show command's query, with its render bound to the device the command ran on. */
export function bindQuery<K extends EngineQueryKind>(
  kind: K,
  render: Render<K>,
  device: IosDevice,
): EngineQuery {
  // `K` is one kind, so this is the union member for it; TypeScript cannot see that through K.
  return { kind, render: (answer: EngineAnswers[K]) => render(answer, device) } as EngineQuery;
}

/** The query with `map` applied to its output, such as an output modifier's filter. */
export function mapQuery(
  query: EngineQuery,
  map: (lines: readonly string[]) => readonly string[],
): EngineQuery {
  // Each member's render takes its own answer; the union's call signature takes their intersection.
  const render = query.render as (answer: never) => readonly string[];
  return { kind: query.kind, render: (answer: never) => map(render(answer)) } as EngineQuery;
}

/** Asks the simulation for each kind of state on one device. Undefined when it cannot answer. */
export type EngineSource = {
  readonly [K in EngineQueryKind]: () => Promise<EngineAnswers[K] | undefined>;
};

/** The query's output from live state, or undefined when the source could not answer. */
export async function answerQuery<K extends EngineQueryKind>(
  query: EngineQuery<K>,
  source: EngineSource,
): Promise<readonly string[] | undefined> {
  const answer = await source[query.kind]();
  return answer === undefined ? undefined : query.render(answer);
}

/** `ping`: echo requests whose fates arrive as the simulation runs. */
export interface PingStream {
  readonly kind: 'ping';
  readonly target: IpAddress;
  readonly options: PingOptions;
}

/** `traceroute`: probes with growing TTLs whose fates arrive as the simulation runs. */
export interface TraceStream {
  readonly kind: 'traceroute';
  readonly target: IpAddress;
  readonly options: TraceOptions;
}

/** `copy` to or from a TFTP server: blocks whose acknowledgements arrive as the simulation runs. */
export interface TftpStream {
  readonly kind: 'tftp';
  readonly request: TftpRequest;
  /** The config file a put copies from, or the one a get loads into. */
  readonly file: ConfigFile;
  /** What the device logs once a get has loaded into the running-config. */
  readonly log?: string;
}

/**
 * A command whose output arrives a piece at a time as the simulation runs, rather than in one
 * answer as a show command's does.
 */
export type EngineStream = PingStream | TraceStream | TftpStream;

type Started = Promise<Result<ProbeHandle, DeviceUnavailable>>;

/** Opens streams on the simulation for one device. */
export interface StreamSource {
  /** Starts a ping. Its events go to `listener` as simulated time passes. */
  ping(target: IpAddress, options: PingOptions, listener: PingListener): Started;
  /** Starts a traceroute. Its events go to `listener` as simulated time passes. */
  traceroute(target: IpAddress, options: TraceOptions, listener: TraceListener): Started;
  /** Stops a ping or traceroute, so no more requests go out. */
  cancel(handle: ProbeHandle): Promise<void>;
  /** Starts a TFTP transfer. Its events go to `listener` as simulated time passes. */
  tftp(request: TftpRequest, listener: TftpListener): Promise<Result<void, DeviceUnavailable>>;
  /**
   * Loads a config file a copy fetched: merged into the running-config line by line, or saved as
   * the startup-config. It commits as one edit.
   */
  load(into: ConfigFile, lines: readonly string[]): void;
  /** The device logs a message, such as `%SYS-5-CONFIG_I`. */
  log(text: string): void;
}

/** Output that arrives in pieces. Pieces are text that breaks lines with `\n`. */
export interface OutputStream {
  /** Writes each piece as it arrives. Resolves once the output is complete or aborted. */
  start(write: (text: string) => void): Promise<void>;
  /** Ends the output early, as Ctrl+Shift+6 does, and stops what the simulation was sending. */
  abort(): void;
}

const UNAVAILABLE: Readonly<Record<DeviceUnavailable, string>> = {
  'unknown-device': '% The simulation has not loaded this device yet.',
  'powered-off': '% The device is powered off.',
  unsupported: '% This device cannot send IP packets.',
};

const asText = (lines: readonly string[]) => lines.map((line) => `${line}\n`).join('');

/** A stream's text, and how to start it on the simulation. */
interface Opened {
  readonly head: string;
  /**
   * Starts it, with the handle that cancels it, if it has one. `emit` gets each event's text, with
   * `last` set for the event that ends it, and `effect` to run once that text is shown.
   */
  start(
    sim: StreamSource,
    emit: (text: string, last: boolean, effect?: () => void) => void,
  ): Promise<Result<ProbeHandle | undefined, DeviceUnavailable>>;
  /** The text that ends the output when it is aborted. */
  abort(): string;
}

function opened(stream: EngineStream): Opened {
  switch (stream.kind) {
    case 'ping': {
      const output = pingOutput(stream);
      return {
        head: output.head,
        abort: output.abort,
        start: (sim, emit) =>
          sim.ping(stream.target, stream.options, (event) =>
            emit(output.next(event), event.kind === 'summary'),
          ),
      };
    }
    case 'traceroute': {
      const output = tracerouteOutput(stream);
      return {
        head: output.head,
        abort: output.abort,
        start: (sim, emit) =>
          sim.traceroute(stream.target, stream.options, (event) =>
            emit(output.next(event), event.kind === 'done'),
          ),
      };
    }
    case 'tftp': {
      const output = tftpOutput(stream);
      return {
        head: output.head,
        abort: output.abort,
        start: async (sim, emit) => {
          const started = await sim.tftp(stream.request, (event) => {
            const text = output.next(event);
            if (event.kind === 'block') return emit(text, false);
            const loaded = event.kind === 'done' && stream.request.op === 'get';
            emit(text, true, loaded ? () => loadInto(sim, stream, event.content) : undefined);
          });
          // A transfer cannot be cancelled: it has no handle.
          return started.ok ? ok(undefined) : started;
        },
      };
    }
  }
}

/** Loads a fetched file, and logs that the running-config changed, as IOS does. */
function loadInto(sim: StreamSource, stream: TftpStream, content: string) {
  sim.load(stream.file, content.split('\n'));
  if (stream.log) sim.log(stream.log);
}

/**
 * Runs the stream against the simulation `source` reaches. When it cannot be reached, the output
 * is `offline`, what the command prints with no simulation. Aborting cancels it in the simulation
 * and ends the output at once, without waiting for the simulation's last event.
 */
export function openStream(
  stream: EngineStream,
  source: () => Promise<StreamSource>,
  offline: readonly string[],
): OutputStream {
  const output = opened(stream);
  let abort = () => {};
  return {
    start(write) {
      return new Promise<void>((resolve) => {
        let open = true;
        let started = false;
        let cancel = () => {};
        const end = (text: string) => {
          if (!open) return;
          open = false;
          write(text);
          resolve();
        };
        abort = () => {
          if (!open) return;
          cancel();
          end(started ? output.abort() : '');
        };
        const run = async () => {
          const sim = await source();
          if (!open) return;
          started = true;
          write(output.head);
          const result = await output.start(sim, (text, last, effect) => {
            if (!open) return;
            if (last) end(text);
            else write(text);
            effect?.();
          });
          if (!result.ok) return end(asText([UNAVAILABLE[result.error]]));
          const handle = result.value;
          if (handle !== undefined) cancel = () => void sim.cancel(handle).catch(() => {});
          // Aborted while the simulation was starting it.
          if (!open) cancel();
        };
        run().catch(() => end(asText(offline)));
      });
    },
    abort: () => abort(),
  };
}
